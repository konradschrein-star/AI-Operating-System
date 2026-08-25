"use client";

/**
 * THOUGHTS — the idea pool, quotes and dreams.
 *
 * ── Why this surface opens on a rebuke ────────────────────────────────────
 * Konrad's own words about his idea list: "un-executed ideas are of course
 * bullshit". So the landing view is not "all ideas" and not "newest first" —
 * it is every idea he has never started, oldest first, with the age in days as
 * the largest number on the row. His doctrine, rendered as a default.
 *
 * The other three views exist for the questions the default cannot answer:
 * BY AREA (which part of my life is this pool actually about), BY IMPORTANCE
 * (what did I say mattered), EXECUTED (what did I actually do). Each is a
 * server-side view — ordering lives in forge-control/src/lib/thoughts.ts, not
 * here, so the list and the API can never disagree about "oldest".
 *
 * ── The store is the vault, not a table ───────────────────────────────────
 * Every idea is a markdown file with frontmatter in Obsidian (PLAN.md §3.2),
 * which is why saves are compare-and-swap and why an unreadable file shows up
 * as an error row rather than as one fewer idea. Agent-derived seeds live on
 * the Forge side of the vault and carry a *derived* badge; Adopt moves the file
 * onto Konrad's side — the correction, and the only irreversible-ish action
 * here (it snapshots first, server-side).
 *
 * ── The page is full before he touches it ─────────────────────────────────
 * The empty state names the mechanism that fills it rather than showing a
 * blank box: the seed script derives the first batch from his Project notes.
 * That is the whole project's rule (PLAN.md §0) and the reason the old Goals
 * surface got 30 days of zeros.
 */

import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../tokens";
import {
  addDream,
  addQuote,
  adoptIdea,
  createIdea,
  fetchThoughts,
  type CreateIdeaInput,
  type Idea,
  type ThoughtArea,
  type ThoughtsView,
} from "../api";
import { areaColor } from "./goals/ui";
import { IdeaList } from "./thoughts/IdeaList";
import { IdeaDetail } from "./thoughts/IdeaDetail";
import { IdeaForm } from "./thoughts/IdeaForm";
import { QuotesDreams } from "./thoughts/QuotesDreams";
import { AREAS, VIEWS, countByArea, viewSummary } from "./thoughts/pool";

export function ThoughtsSurface() {
  const qc = useQueryClient();
  const [view, setView] = useState<ThoughtsView>("unexecuted");
  /* BY AREA is a server-side filter that REQUIRES an area (the store 400s
   * without one), so the surface always holds a current area — it is also what
   * the quick-add box files a new idea under while that view is open. */
  const [area, setArea] = useState<ThoughtArea>("business");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const poolQ = useQuery({
    queryKey: ["thoughts", view, view === "area" ? area : null],
    queryFn: () => fetchThoughts(view, view === "area" ? area : undefined),
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
  });

  const ideas: Idea[] = useMemo(() => poolQ.data?.ideas ?? [], [poolQ.data]);
  const counts = useMemo(() => countByArea(ideas), [ideas]);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ["thoughts"] });
  };

  const flash = (msg: string): void => {
    setBanner(msg);
    window.setTimeout(() => setBanner((b) => (b === msg ? null : b)), 4000);
  };

  const fail = (what: string) => (e: unknown) =>
    flash(`could not ${what}: ${e instanceof Error ? e.message : String(e)}`);

  const createM = useMutation({
    mutationFn: (input: CreateIdeaInput) => createIdea(input),
    onSuccess: (r) => {
      invalidate();
      flash(`captured: ${r.idea.idea}`);
    },
    onError: fail("capture that"),
  });

  const adoptM = useMutation({
    mutationFn: (idea: Idea) => adoptIdea(idea.path),
    onSuccess: (r) => {
      invalidate();
      // The file MOVED — the old path no longer exists, so an open drawer has
      // to follow it or close rather than sit on a dead path.
      setOpenPath((p) => (p === null ? null : r.idea.path));
      flash(`adopted → ${r.idea.path}`);
    },
    onError: fail("adopt that seed"),
  });

  const quoteM = useMutation({
    mutationFn: ({ text, source }: { text: string; source?: string }) => addQuote(text, source),
    onSuccess: invalidate,
    onError: fail("add that quote"),
  });

  const dreamM = useMutation({
    mutationFn: (text: string) => addDream(text),
    onSuccess: invalidate,
    onError: fail("add that dream"),
  });

  const open = openPath ? (ideas.find((i) => i.path === openPath) ?? null) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        padding: 14,
        gap: 10,
        background: tokens.bgBody,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: tokens.textHi }}>Thoughts</span>
        <span className="mono" style={{ fontSize: 11, color: tokens.textSoft }}>
          {viewSummary(view, ideas)}
        </span>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {banner && (
            <span className="mono" style={{ fontSize: 10, color: tokens.accent }}>
              {banner}
            </span>
          )}
          {poolQ.isError && (
            <span className="mono" style={{ fontSize: 10, color: tokens.bleed }}>
              vault unreachable:{" "}
              {poolQ.error instanceof Error ? poolQ.error.message : String(poolQ.error)}
            </span>
          )}
          {poolQ.data && (
            <span className="mono" style={{ fontSize: 10, color: tokens.textGhost }}>
              {poolQ.data.layout} layout
            </span>
          )}
        </div>
      </div>

      {/* Views */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flexShrink: 0 }}>
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            title={v.hint}
            data-thoughts-view={v.key}
            style={{
              padding: "6px 12px",
              borderRadius: 7,
              border: `1px solid ${view === v.key ? tokens.accent : tokens.border}`,
              background: view === v.key ? tokens.selectedBg : "transparent",
              color: view === v.key ? tokens.accent : tokens.textSoft,
              fontSize: 11,
              letterSpacing: "0.08em",
              cursor: "pointer",
            }}
          >
            {v.label}
          </button>
        ))}

        {view === "area" && (
          <div style={{ display: "flex", gap: 5, marginLeft: 8, flexWrap: "wrap" }}>
            {AREAS.map((a) => (
              <button
                key={a}
                onClick={() => setArea(a)}
                style={{
                  padding: "6px 11px",
                  borderRadius: 7,
                  border: `1px solid ${area === a ? areaColor(a) : tokens.borderSoft}`,
                  background: area === a ? tokens.selectedBg : "transparent",
                  color: area === a ? areaColor(a) : tokens.textMuted,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {a}
                {area === a && counts[a] > 0 ? ` · ${counts[a]}` : ""}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Pool + side panel */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "1fr minmax(260px, 340px)",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, gap: 10 }}>
          <IdeaForm
            onCreate={(input) => createM.mutate(input)}
            busy={createM.isPending}
            defaultArea={view === "area" ? area : undefined}
          />
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 2 }}>
            <IdeaList
              ideas={ideas}
              view={view}
              loading={poolQ.isLoading}
              errors={poolQ.data?.errors ?? []}
              selectedPath={openPath}
              onOpen={(idea) => setOpenPath(idea.path)}
              onAdopt={(idea) => adoptM.mutate(idea)}
              adoptingPath={adoptM.isPending ? (adoptM.variables?.path ?? null) : null}
            />
          </div>
        </div>

        <div
          style={{
            minHeight: 0,
            overflowY: "auto",
            borderLeft: `1px solid ${tokens.borderDivider}`,
            paddingLeft: 12,
          }}
        >
          <QuotesDreams
            quotes={poolQ.data?.quotes ?? []}
            dreams={poolQ.data?.dreams ?? []}
            onAddQuote={(text, source) => quoteM.mutate({ text, source })}
            onAddDream={(text) => dreamM.mutate(text)}
            busy={quoteM.isPending || dreamM.isPending}
          />
        </div>
      </div>

      {open && (
        <IdeaDetail
          idea={open}
          onClose={() => setOpenPath(null)}
          onSaved={(saved) => {
            invalidate();
            setOpenPath(saved.path);
            flash("saved");
          }}
          onConflict={invalidate}
          onAdopt={(idea) => adoptM.mutate(idea)}
        />
      )}
    </div>
  );
}
