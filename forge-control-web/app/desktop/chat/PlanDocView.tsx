"use client";

/**
 * PlanDocView — the middle surface when the top of the nav stack is a plan
 * document (U26, 13 §1). A SHELL, and deliberately an inert one.
 *
 * ── What it does not do, on purpose ───────────────────────────────────────
 * It fetches NOTHING. The `GET /api/chat/:id/plan/doc?name=` endpoint (U6) is
 * phase 700's to build and phase 700's to wire; a placeholder that hit a route
 * which does not exist yet would render an error state that says more about
 * the schedule than about the system. Nothing pushes a `plandoc` frame in this
 * round either — the Kanban that would do it lands with the endpoint. The
 * frame kind and this component exist now so the stack's shape is settled
 * before there are two callers to migrate (see nav-stack.ts).
 *
 * The header, the back button and the placeholder body are real. When phase
 * 700 arrives, the change here is one query and swapping the placeholder for
 * `<MessageMarkdown>` — the navigation around it is already proven by the
 * agent drill-in that ships this round.
 */

import { tokens } from "../../tokens";
import { BackButton } from "./AgentChatView";
import { crumbs, type NavStack } from "./nav-stack";

export interface PlanDocViewProps {
  /** The doc's file name, e.g. `13-ui-v3-architecture.md`. Carried verbatim
   *  from the frame — this view never resolves it to a path, because path
   *  resolution (and its `realpath` containment check) is a server concern
   *  (13 §3). */
  name: string;
  /** The whole stack, for the lineage crumb. */
  stack: NavStack;
  onBack: () => void;
  backLabel: string;
}

export function PlanDocView({ name, stack, onBack, backLabel }: PlanDocViewProps) {
  const trail = crumbs(stack);

  return (
    <div
      data-plan-doc-view
      data-doc-name={name}
      data-depth={stack.length}
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
        }}
      >
        <BackButton label={backLabel} onClick={onBack} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
            <span
              className="mono"
              style={{
                flex: "none",
                fontSize: 9.5,
                letterSpacing: "0.04em",
                color: tokens.decide,
              }}
            >
              plan doc
            </span>
            <span
              data-doc-title
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                color: tokens.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {name}
            </span>
          </div>
          <div
            data-nav-crumbs
            className="mono"
            style={{
              fontSize: 9.5,
              color: tokens.textFaint,
              letterSpacing: "0.03em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {trail.map((c, i) => (
              <span key={`${c.depth}:${c.id ?? "root"}`}>
                {i > 0 && <span style={{ color: tokens.textGhost }}> › </span>}
                <span
                  style={{ color: i === trail.length - 1 ? tokens.textMuted : undefined }}
                >
                  {c.label}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div
        className="mono"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "20px 28px",
          fontSize: 11,
          lineHeight: 1.7,
          color: tokens.textFaint,
        }}
      >
        plan documents render here in phase 700, once{" "}
        <span style={{ color: tokens.textMuted }}>GET /api/chat/:id/plan/doc</span> exists
        (U6). Navigation is live now — back returns to {backLabel}.
      </div>
    </div>
  );
}

export default PlanDocView;
