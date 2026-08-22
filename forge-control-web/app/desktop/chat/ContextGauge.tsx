"use client";

/** The "ctx" gauge — third bar in the status row, next to 5h and 7d.
 *
 *  Konrad, 2026-08-16: "in these chats I need an indication of how far the
 *  context window of the current chat is used up, place it next to the other
 *  two usage bars at the bottom so I know when to type /compact".
 *
 *  THREE DESIGN DECISIONS WORTH THE READ
 *
 *  1. IT COSTS ZERO NEW REQUESTS. The status bar lives in DesktopApp and has
 *     no idea which chat is on screen, so ChatSurface PUBLISHES the target
 *     (`publishContextTarget`) and this component subscribes. It then reads
 *     the run through the SAME react-query key the chat surface already polls
 *     — `["chat","run",<id>]` — with `staleTime: Infinity` and no interval of
 *     its own. Two observers on one cache entry: when the surface's 3s/20s
 *     poll lands, this gauge re-renders with it. The surface's poll budget
 *     (ChatSurface's 38 req/min arithmetic) does not move by one request.
 *
 *  2. IT FOLLOWS THE SCREEN, NOT THE SIDEBAR. Drill into a worker from the
 *     right panel and the published target becomes that worker's run, because
 *     that is the transcript in the middle. A sub-agent frame publishes the
 *     parent run WITH its `subagentId`, and the gauge deliberately renders the
 *     placeholder there — see `SUBAGENT_UNKNOWN` below.
 *
 *  3. IT NEVER BLOCKS THE COMPOSER. No suspense, no error boundary needed:
 *     an absent target renders nothing, an unknown number renders "—". The
 *     query is `enabled` only when there is something honest to fetch.
 */

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { GEMINI_ACCENT, isGeminiModel } from "../gemini-identity";
import { fetchChat } from "../../api";
import { modelDisplay } from "../live/agentsApi";
import {
  contextBand,
  contextOccupancy,
  humanTokens,
  type ContextBand,
} from "./context-window";

/* ── The on-screen target ─────────────────────────────────────────────────
 *
 * A `useSyncExternalStore` source, same shape as `team/tickStore.ts`: one
 * module-level value, a listener set, and a snapshot that is STABLE by
 * identity between publishes. `publishContextTarget` bails when nothing
 * changed, so ChatSurface can call it on every render without looping React.
 */

export interface ContextTarget {
  /** The run whose thread is rendered in the middle surface. */
  runId: string;
  /** Set when the middle surface shows a sub-agent slice of that run. */
  subagentId?: string;
}

let target: ContextTarget | null = null;
const listeners = new Set<() => void>();

function sameTarget(a: ContextTarget | null, b: ContextTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.runId === b.runId && a.subagentId === b.subagentId;
}

/** Say what the middle surface is showing. `null` when it is showing no chat
 *  (another surface, the composer, a plan doc). */
export function publishContextTarget(next: ContextTarget | null): void {
  if (sameTarget(target, next)) return;
  target = next;
  for (const cb of listeners) cb();
}

function subscribeContextTarget(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getContextTargetSnapshot(): ContextTarget | null {
  return target;
}

/** SSR snapshot: no chat is open on the server, and it must be a constant so
 *  hydration agrees. */
function getServerContextTargetSnapshot(): ContextTarget | null {
  return null;
}

/* ── The gauge ────────────────────────────────────────────────────────── */

const BAND_TOKEN: Record<ContextBand, string> = {
  calm: tokens.ok,
  noticed: tokens.info,
  warn: tokens.warn,
  danger: tokens.bleed,
};

/** Why a drilled sub-agent shows "—" instead of a number.
 *
 *  A Task sub-agent has its own context window, and nothing records its
 *  per-turn input. `subagents_v2[].usage` is a SUM across every assistant
 *  message the rollup attributed to it (run-rollup.ts:246-253), which is an
 *  aggregate, not an occupancy — dividing it by a window would produce a
 *  number that grows past 100% on a long sub-agent while its real context sat
 *  low. Criterion 5 of the brief says the gauge follows what is on screen; it
 *  does, and on this screen the honest answer is that the figure is not
 *  recorded. */
const SUBAGENT_UNKNOWN =
  "ctx — sub-agent context is not recorded per turn (its usage is an aggregate across turns, not the tokens one turn carries). Drill back up for the session's context.";

export function ContextGauge() {
  const t = useSyncExternalStore(
    subscribeContextTarget,
    getContextTargetSnapshot,
    getServerContextTargetSnapshot,
  );
  const runId = t?.runId ?? null;
  const isSubagent = t?.subagentId !== undefined;

  /* Same key namespace as ChatSurface/AgentChatView, so this is a READER of
   * their cache entry. `staleTime: Infinity` + no `refetchInterval` means it
   * never schedules a fetch of its own; it only fetches once if it somehow
   * mounts before the surface has populated the entry. */
  const q = useQuery({
    queryKey: ["chat", "run", runId],
    queryFn: () => fetchChat(runId!),
    enabled: !!runId && !isSubagent,
    staleTime: Infinity,
    refetchInterval: false,
  });

  // Nothing on screen → nothing to say. Not a placeholder: a "ctx —" parked
  // in the status bar while Konrad is on the Money surface is noise.
  if (!t) return null;

  if (isSubagent) return <Gauge title={SUBAGENT_UNKNOWN} />;

  const occ = contextOccupancy(q.data?.metadata);
  if (!occ) {
    return (
      <Gauge
        title={
          q.isError
            ? "ctx — could not load this chat's usage"
            : "ctx — this chat has not recorded a turn's token usage yet"
        }
      />
    );
  }

  const pct = occ.fraction * 100;
  /* Engine identity while the window is CALM; pressure once it is not.
   *
   * Konrad asked for the Gemini context bar to read purple rather than blue.
   * It does — up to 75%, where warn takes over and then danger. Identity and
   * pressure are different axes, and if purple survived into the red band a
   * reader would have to ask whether the bar is coloured because of the engine
   * or because the window is nearly full. The engine is already legible from
   * the model name in the title; a full window is not legible from anything
   * else, so pressure wins the tie. Same rule as the gem quota bars. */
  const band = contextBand(occ.fraction);
  const gemini = isGeminiModel(occ.model);
  const color = gemini && (band === "calm" || band === "noticed")
    ? GEMINI_ACCENT
    : BAND_TOKEN[band];
  const model = occ.model ? modelDisplay(occ.model) : "unknown model";
  const window = `${humanTokens(occ.windowTokens)}${occ.assumedWindow ? " (assumed)" : ""}`;
  return (
    <Gauge
      title={`ctx: ${humanTokens(occ.usedTokens)} / ${window} · ${model}${
        occ.fraction >= 0.75 ? " · /compact" : ""
      }`}
      fill={Math.min(100, Math.max(0, pct))}
      color={color}
      value={`${Math.round(pct)}%`}
    />
  );
}

/** The bar itself. Dimensions, track colour and layout are copied from
 *  `QuotaBars.Bar` deliberately — Konrad asked for "the same visual language"
 *  as the two gauges beside it, and the two live in different components only
 *  because this one has its own data path. Tokens only, both themes. */
function Gauge({
  title,
  fill,
  color,
  value,
}: {
  title: string;
  fill?: number;
  color?: string;
  value?: string;
}) {
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
      title={title}
      data-context-gauge
      data-context-pct={value ?? ""}
    >
      <span style={{ color: tokens.textFaint }}>ctx</span>
      <span
        style={{
          width: 46,
          height: 5,
          borderRadius: 3,
          background: tokens.borderEmphasis,
          overflow: "hidden",
          display: "inline-block",
        }}
      >
        {fill !== undefined && (
          <span
            style={{
              display: "block",
              width: `${fill}%`,
              height: "100%",
              background: color,
            }}
          />
        )}
      </span>
      <span style={{ color: color ?? tokens.textGhost }}>{value ?? "—"}</span>
    </span>
  );
}
