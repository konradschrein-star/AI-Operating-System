"use client";

/**
 * StorySoFar — the collapsed "where do things stand" block above a long
 * transcript (U24, 13 §8).
 *
 * Konrad, watching a worker live: "I'm completely fucking confused by what
 * they are telling me and what's going on in the background." Three hundred
 * entries is not a story; this is the block you read instead of scrolling.
 *
 * ── It is a RENDERER. All of it. ──────────────────────────────────────────
 * The derivation is round 601A's `deriveDigest(run, thread)`, which is pure.
 * This file adds no data: no request, no query hook, no import of anything that
 * talks to the network, and no model in the render path —
 * `13-ui-v3-architecture.md §8` names a summariser in the render path as an
 * explicit anti-goal, and this component is exactly where one would have gone.
 * The gate is mechanical, not a promise: grepping this file for a request or a
 * query hook returns nothing.
 *
 * ── The three honesty rules, and where each is enforced ───────────────────
 *   COUNTS ARE COUNTS. Every number below comes straight off the digest, and
 *       every label says what it counts. `error_count` is rendered "tool
 *       errors", never "failures": `digest-gap.md §4` measured all three on
 *       the reference session and all three were routine and recovered from.
 *   PROSE IS VERBATIM. `snippets[].text` is a leading substring of something
 *       the agent actually wrote, marked when it is a prefix, stamped with the
 *       entry's own `ts`. Nothing on this surface is paraphrased.
 *   NOTHING UNDERIVED IS ASSERTED. What the digest cannot know is named in
 *       `docs/plan/artifacts/phase600/digest-gap.md`, and the expanded footer
 *       points at it — the gap is visible in the product, not only in a doc.
 *
 * ── Time truth (Definition of Done #1) ────────────────────────────────────
 * A settled run shows `completed_at − started_at`, frozen, identical at any
 * clock. A running one shows its start and NO duration: `deriveDigest` returns
 * `elapsed_ms: null` while a run is live precisely so nothing here can invent
 * a growing number. This component reads no clock and holds no timer.
 *
 * ── Why a sub-agent's block has no time line ──────────────────────────────
 * A sub-agent is not a run. `AgentChatView.synthesizeSubagentRun` hands it the
 * PARENT's timestamps on purpose — they are the literal truth about an
 * in-process Task call — but rendering them under the child's name would read
 * as the child's own duration. So `scope="subagent"` replaces the time line
 * with the reason there isn't one.
 */

import { useMemo, useState } from "react";
import { tokens } from "../../tokens";
import type { RunDetail, ThreadEntry } from "../../api";
import { fmtWorkingTime } from "../team/teamApi";
import { deriveDigest, type StoryDigest } from "./story-digest";

const EM_DASH = "—";

/** Where the underivable facts are written down. Rendered as a path rather
 *  than a link on purpose: nothing serves repo docs to the browser today (the
 *  U6 doc endpoint is phase 700's), and an anchor that 404s would be a worse
 *  pointer than a path you can open in an editor. */
const GAP_DOC = "docs/plan/artifacts/phase600/digest-gap.md";

/** What each count actually counts, as a tooltip. Written out because a count
 *  with a vague label is how "3 tool errors" becomes "3 failures". */
const COUNT_TITLE = {
  entries:
    "Every thread entry handed to the digest — prose, tool calls, tool results, " +
    "errors, heartbeats.",
  own: "Entries belonging to this agent itself: no meta.parent_tool_use_id on them.",
  delegated:
    "Entries written by in-process sub-agents, stamped meta.parent_tool_use_id. " +
    "They are inline in this thread, not a separate run.",
  tools: "Entries with kind = 'tool_call', sub-agents included.",
  errors:
    "Entries flagged meta.is_error, plus kind = 'error' entries. That is " +
    "'tool calls that returned an error' — not 'problems', and not 'failures'. " +
    "A run can complete successfully with several of these.",
  subagents:
    "Sub-agents with entries in this thread, plus ones spawned here that have " +
    "not produced any yet. A role the executor has not stamped reads 'unknown' " +
    "rather than being guessed.",
} as const;

const TASK_SOURCE_TITLE: Record<StoryDigest["task_source"], string> = {
  title: "the run's own title",
  user_entry: "derived from the first user entry in the thread",
  none: "no task could be derived",
};

const OUTCOME_SOURCE_TITLE: Record<StoryDigest["outcome_source"], string> = {
  assistant_prose: "the agent's own last prose turn, verbatim",
  current_activity:
    "no prose turn in scope — this is metadata.current_activity.text, verbatim",
  none: "nothing to derive an outcome from",
};

/** One `label value` pair on the counts row. */
function Count({
  value,
  label,
  title,
  color,
}: {
  value: number | string;
  label: string;
  title: string;
  color?: string;
}) {
  return (
    <span
      className="mono"
      title={title}
      style={{ flex: "none", color: tokens.textMuted, whiteSpace: "nowrap" }}
    >
      <span style={{ color: color ?? tokens.text }}>{value}</span> {label}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 9,
        letterSpacing: "0.08em",
        color: tokens.textFaint,
        paddingBottom: 3,
      }}
    >
      {children}
    </div>
  );
}

export interface StorySoFarProps {
  /** The run the digest describes. For a sub-agent view this is the
   *  synthesized one AgentChatView built — its title and status are the
   *  sub-agent's, its timestamps are the parent's, which is why `scope`
   *  exists. */
  run: RunDetail;
  /** The entries in scope. Already narrowed by the caller for a sub-agent. */
  thread: readonly ThreadEntry[];
  /** Which of the two things is being digested. Decides one thing only: the
   *  time line. */
  scope: "session" | "subagent";
  /** Starts expanded. Off everywhere in the app — U24 says collapsed by
   *  default — and used by the offline capture harness, which renders to static
   *  HTML and therefore cannot click. */
  defaultOpen?: boolean;
}

export function StorySoFar({ run, thread, scope, defaultOpen = false }: StorySoFarProps) {
  const [open, setOpen] = useState(defaultOpen);

  /* The one derivation. Pure, so memoising it is an optimisation and never a
   * correctness question — same (run, thread) in, same digest out. */
  const digest = useMemo(() => deriveDigest(run, thread), [run, thread]);

  /* U24: below the bar there is nothing to summarise, and a digest of a
   * twelve-entry thread is noise sitting on top of the thread it summarises. */
  if (!digest.show) return null;

  const delegated = digest.subagent_entry_count;
  const roles = digest.subagent_roles.length > 0 ? digest.subagent_roles.join(", ") : null;

  return (
    <div
      data-story-so-far
      data-story-open={open ? "1" : "0"}
      style={{
        flex: "none",
        borderBottom: `1px solid ${tokens.borderSoft}`,
        background: open ? tokens.toolBg : "transparent",
      }}
    >
      {/* Collapsed line — the same click-to-expand idiom as a tool row in the
          transcript below it, so the surface has one vocabulary for "there is
          more inside this". */}
      <div
        data-story-toggle
        onClick={() => setOpen((v) => !v)}
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 14px",
          cursor: "pointer",
          fontSize: 10.5,
          userSelect: "none",
        }}
      >
        <span style={{ flex: "none", color: tokens.textLabel, fontWeight: 600 }}>
          story so far
        </span>
        <Count
          value={digest.entry_count}
          label="entries"
          title={COUNT_TITLE.entries}
        />
        <Count value={digest.tool_call_count} label="tool calls" title={COUNT_TITLE.tools} />
        {digest.error_count > 0 && (
          <Count
            value={digest.error_count}
            label="tool errors"
            title={COUNT_TITLE.errors}
            color={tokens.warn}
          />
        )}
        {digest.subagent_count > 0 && (
          <Count
            value={digest.subagent_count}
            label={roles === null ? "sub-agents" : `sub-agents (${roles})`}
            title={COUNT_TITLE.subagents}
          />
        )}
        <span style={{ flex: 1 }} />
        <span style={{ flex: "none", color: tokens.textGhost }}>{open ? "▾" : "▸"}</span>
      </div>

      {open && (
        <div
          style={{
            borderTop: `1px solid ${tokens.borderDivider}`,
            padding: "8px 14px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}
        >
          {/* ── Task ─────────────────────────────────────────────────────── */}
          <div>
            <SectionLabel>TASK</SectionLabel>
            <div
              className="mono"
              style={{ fontSize: 11, color: tokens.textBody, lineHeight: 1.5 }}
            >
              {digest.task}{" "}
              <span
                title={TASK_SOURCE_TITLE[digest.task_source]}
                style={{ color: tokens.textGhost }}
              >
                ({digest.task_source.replace("_", " ")})
              </span>
            </div>
          </div>

          {/* ── Time ─────────────────────────────────────────────────────── */}
          <div>
            <SectionLabel>TIME</SectionLabel>
            <div className="mono" style={{ fontSize: 10.5, color: tokens.textMuted }}>
              {scope === "subagent" ? (
                <span
                  title={
                    "A sub-agent is a Task call inside its parent's process — it has " +
                    "no run row and no independent start or end stamp in this payload. " +
                    "The parent's timestamps are not restated here under its name."
                  }
                  style={{ color: tokens.textGhost, fontStyle: "italic" }}
                >
                  in-process sub-agent — no independent start or duration recorded
                </span>
              ) : (
                <>
                  <span style={{ color: tokens.textBody }}>
                    {digest.started_at ?? EM_DASH}
                  </span>
                  {"  ·  "}
                  {digest.elapsed_frozen && digest.elapsed_ms !== null ? (
                    <span
                      data-story-elapsed="frozen"
                      title={
                        "completed_at − started_at. Frozen: this run has settled, so " +
                        "the number is the same at any clock and never ticks again."
                      }
                      style={{ color: tokens.text }}
                    >
                      ran {fmtWorkingTime(digest.elapsed_ms)}
                    </span>
                  ) : (
                    <span
                      data-story-elapsed="live"
                      title={
                        "Still running. The digest is a pure function and does not read " +
                        "a clock, so it states no duration — a number here would grow " +
                        "in a block that is not supposed to move."
                      }
                      style={{ color: tokens.warn }}
                    >
                      {digest.status} — no duration while live
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ── Counts, spelled out ──────────────────────────────────────── */}
          <div>
            <SectionLabel>WORK</SectionLabel>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "4px 14px",
                fontSize: 10.5,
              }}
            >
              <Count value={digest.entry_count} label="entries" title={COUNT_TITLE.entries} />
              {/* The own/delegated split is only meaningful for a thread that
                  HAS both halves. In a sub-agent slice every entry carries a
                  `parent_tool_use_id` by construction, so `top_level_count` is
                  0 and `delegated` is the whole slice — rendering "0 its own,
                  118 delegated" over a scout's own 118 entries would be a
                  mislabel produced by a definition, not by the data. */}
              {digest.prose_scope === "top-level" ? (
                <>
                  <Count
                    value={digest.top_level_count}
                    label="its own"
                    title={COUNT_TITLE.own}
                  />
                  <Count value={delegated} label="delegated" title={COUNT_TITLE.delegated} />
                </>
              ) : (
                <span
                  className="mono"
                  title={
                    "Every entry in this slice is stamped with this sub-agent's " +
                    "parent_tool_use_id, so the own-vs-delegated split has nothing to " +
                    "split. It is the parent's to make, and its block makes it."
                  }
                  style={{ flex: "none", color: tokens.textGhost }}
                >
                  all its own
                </span>
              )}
              <Count
                value={digest.tool_call_count}
                label="tool calls"
                title={COUNT_TITLE.tools}
              />
              <Count
                value={digest.error_count}
                label="tool errors"
                title={COUNT_TITLE.errors}
                color={digest.error_count > 0 ? tokens.warn : undefined}
              />
              <Count
                value={digest.subagent_count}
                label="sub-agents"
                title={COUNT_TITLE.subagents}
              />
              {roles !== null && (
                <span
                  className="mono"
                  title={COUNT_TITLE.subagents}
                  style={{ flex: "none", color: tokens.textGhost }}
                >
                  {roles}
                </span>
              )}
            </div>
          </div>

          {/* ── The agent's own words ────────────────────────────────────── */}
          {digest.snippets.length > 0 && (
            <div>
              <SectionLabel>
                LAST {digest.snippets.length} TURNS, VERBATIM{" "}
                <span style={{ letterSpacing: 0 }}>
                  (
                  {digest.prose_scope === "top-level"
                    ? "this agent's own prose only"
                    : "this slice's prose"}
                  )
                </span>
              </SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {digest.snippets.map((s, i) => (
                  <div
                    key={`${s.ts}:${i}`}
                    data-story-snippet={s.clipped ? "clipped" : "whole"}
                    style={{
                      display: "flex",
                      gap: 8,
                      fontSize: 10.5,
                      lineHeight: 1.5,
                      borderLeft: `2px solid ${tokens.borderDivider}`,
                      paddingLeft: 8,
                    }}
                  >
                    <span
                      className="mono"
                      style={{ flex: "none", color: tokens.textGhost }}
                      title={s.ts}
                    >
                      {s.ts.slice(11, 19) || EM_DASH}
                    </span>
                    <span style={{ color: tokens.textBody, overflowWrap: "anywhere" }}>
                      {s.text}
                      {s.clipped && (
                        <span
                          title="A verbatim leading substring — the entry continues in the transcript below."
                          style={{ color: tokens.textGhost }}
                        >
                          {" "}
                          [clipped]
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Where it stands ─────────────────────────────────────────── */}
          {digest.outcome !== null && (
            <div>
              <SectionLabel>
                WHERE IT STANDS{" "}
                <span
                  style={{ letterSpacing: 0 }}
                  title={OUTCOME_SOURCE_TITLE[digest.outcome_source]}
                >
                  ({digest.outcome_source.replace("_", " ")})
                </span>
              </SectionLabel>
              <div
                style={{
                  fontSize: 11,
                  lineHeight: 1.55,
                  color: tokens.textBody,
                  overflowWrap: "anywhere",
                }}
              >
                {digest.outcome}
              </div>
            </div>
          )}

          {/* ── What this block cannot know ──────────────────────────────── */}
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              lineHeight: 1.5,
              color: tokens.textGhost,
              borderTop: `1px solid ${tokens.borderDivider}`,
              paddingTop: 7,
            }}
          >
            derived, never summarised — no model reads this thread. What it{" "}
            <em>cannot</em> know (causality, abandoned branches, quality, per-entry
            cost) is written down in{" "}
            <span
              data-story-gap-doc
              title={
                "The measured list of what U23/U24 cannot derive from the stored " +
                "thread, and what it would take to get each one. Written by round " +
                "601A against the 285-entry reference capture."
              }
              style={{ color: tokens.textMuted, userSelect: "all" }}
            >
              {GAP_DOC}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default StorySoFar;
