"use client";

/**
 * PlanDocView — the middle surface when the top of the nav stack is a plan
 * document (U26, 13 §1). Phase 300 shipped `GET /api/chat/:id/plan/doc`
 * (forge-control/src/routes/chat.ts:1048): 200 `text/markdown` on success,
 * 400/404/413/500 JSON `{error, name}` on failure. This component is the
 * reader — one query, `MessageMarkdown` for the body, the server's own
 * sentence on failure.
 *
 * ── Server-side containment, client-side trust ────────────────────────────
 * `name` never gets resolved to a path here — that is the endpoint's job
 * (`resolvePlanDoc`, chat.ts), including the `realpath` traversal check that
 * turns `../../../../etc/passwd` into a 400. This view just asks for the name
 * it was handed and renders whatever the server allows or refuses.
 *
 * ── Getting the chat id without a new prop ─────────────────────────────────
 * `fetchPlanDoc` needs the CHAT id, but `PlanDocViewProps` (fixed by this
 * round's file split — ChatSurface.tsx is a different task's file) carries
 * only the doc `name`, and the `plandoc` `NavFrame` doesn't carry it either
 * (nav-stack.ts). Rather than add a prop and collide with the other task's
 * file, this follows OrientationStrip's established idiom (OrientationStrip.tsx
 * "Why the team tree is read from the cache instead of with useQuery"):
 * OBSERVE the query cache instead of asking for a value nobody handed down.
 * ChatSurface always runs `useQuery({queryKey: ["chat","linkage",selId],
 * enabled: !!selId, ...})` — unconditionally, independent of the nav stack,
 * the panel tab, or panel-collapsed state (ChatSurface.tsx:491-497) — for as
 * long as a chat is open at all, drilled in or not. That query key's third
 * element IS `selId`, i.e. exactly the open chat id this view needs, so
 * reading the active query's key (not its data) recovers it with zero new
 * requests and zero new plumbing. `["chat","linkage",…]` has exactly one
 * call site in the whole app (ChatSurface.tsx), so there is never more than
 * one candidate to pick from.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import { fetchPlanDoc } from "../team/planApi";
import { MessageMarkdown } from "./MessageMarkdown";
import { BackButton } from "./AgentChatView";
import { crumbs, type NavStack } from "./nav-stack";

/** The open chat's id, read off the query cache — see the file header. `null`
 *  only when no chat is open at all, which cannot happen while this view is
 *  mounted (you can only drill into a plan doc from an open chat's team
 *  panel), but the type says so honestly rather than asserting it away. */
function useOpenChatId(): string | null {
  const queryClient = useQueryClient();
  const active = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["chat", "linkage"], type: "active" });
  const id = active[0]?.queryKey[2];
  return typeof id === "string" && id ? id : null;
}

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
  const chatId = useOpenChatId();

  const docQ = useQuery({
    queryKey: ["plan-doc", chatId, name],
    queryFn: () => fetchPlanDoc(chatId as string, name),
    enabled: chatId !== null,
    staleTime: 60_000,
    retry: 0,
    refetchOnWindowFocus: false,
  });

  const docState: "loading" | "error" | "ready" =
    chatId === null || docQ.isError ? "error" : docQ.isSuccess ? "ready" : "loading";

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
        data-doc-state={docState}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px" }}
      >
        {docState === "error" ? (
          <div className="mono" style={{ fontSize: 11, lineHeight: 1.7, color: tokens.bleed }}>
            {chatId === null
              ? "could not resolve the open chat — no active chat-linkage query in the cache"
              : (docQ.error instanceof Error ? docQ.error.message : "unknown error")}
          </div>
        ) : docState === "loading" ? (
          <div className="mono" style={{ fontSize: 11, lineHeight: 1.7, color: tokens.textFaint }}>
            loading {name}…
          </div>
        ) : (
          <MessageMarkdown source={docQ.data ?? ""} />
        )}
      </div>
    </div>
  );
}

export default PlanDocView;
