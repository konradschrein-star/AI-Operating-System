"use client";

/**
 * The luminescent 3D net of the second brain — and, since 2026-08-19, an
 * HONEST one.
 *
 * WHAT CHANGED AND WHY (B2e, R33-R35).
 * It used to read `GET /api/memory/graph` when that endpoint was built from
 * `content_forge.knowledge_triples`, a table that has held **0 rows** since
 * some point before 2026-08-19 with nothing to refill it: the extractor is
 * manual-only and scheduling it is an explicit non-goal. So the scene was
 * empty, and the status chip said *"no graph yet — index the vault"* — advice
 * that would not have worked, for a reason the surface could not name.
 *
 * B2b repointed the endpoint at `hcp.knowledge_note.links`, the parsed
 * [[wikilinks]] the vault-sync tick already refreshes every 5 minutes at zero
 * marginal cost. Measured live: 292 nodes, 624 edges, 288 notes scanned, 122
 * carrying links, **128 unresolved targets**, 1 self-link dropped.
 *
 * THE RENDERER WAS NEVER THE PROBLEM and is barely touched. This component's
 * job is the three things the old one could not do:
 *
 *   1. UNRESOLVED TARGETS ARE MARKED (R34). A wikilink with no note behind it
 *      is a note Konrad MEANT to write. It is drawn — dimmer, cooler, smaller,
 *      and named as unresolved when picked — never dropped. 128 of 292 nodes
 *      are in that state; silently omitting them would under-report the graph
 *      by 44% while looking perfectly healthy.
 *   2. EVERY FIGURE IN THE RAIL CARRIES ITS UNIT AND ITS SOURCE (R33), taken
 *      from WikilinkGraphCounts' own doc comments rather than invented here.
 *      `links_total` IS `links.length` by construction, so the rail describes
 *      the scene actually drawn.
 *   3. AN EMPTY GRAPH SAYS WHY (R35), in the server's own words: `empty_reason`
 *      names the table read and the rows found. It is non-null ONLY when there
 *      are no nodes.
 *
 * 3d-force-graph touches `window` at module scope, so it is imported
 * dynamically inside useEffect — never at the top level (Next SSR build).
 *
 * This file is an allowlisted carrier of raw colour literals
 * (scripts/checks/raw-colour-allowlist.txt): it paints into a WebGL context
 * that never sees the CSS cascade, so it must carry its own palette.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import { fetchWikilinkGraph, type WikilinkNode } from "../api-vault";

/** Deterministic luminescent palette — violet/cyan/magenta band. */
function nodeColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = 190 + (h % 140); // 190..330 — cyan → violet → magenta
  const sat = 78 + (h % 18);
  const light = 58 + ((h >> 3) % 14);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

/** Unresolved targets get ONE colour, not a hashed one: they are a class, and
 *  a reader must be able to see the class at a glance rather than decode 128
 *  individually-tinted spheres. Desaturated amber — visibly "pending", not an
 *  error. */
const UNRESOLVED_COLOR = "hsl(38, 34%, 52%)";

function colorFor(node: WikilinkNode): string {
  return node.resolved ? nodeColor(node.id) : UNRESOLVED_COLOR;
}

export function MemoryGraph3D({
  onSelectNote,
}: {
  onSelectNote: (slug: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<{ _destructor?: () => void } | null>(null);
  const [picked, setPicked] = useState<WikilinkNode | null>(null);

  const dataQ = useQuery({
    queryKey: ["memory", "wikilink-graph"],
    queryFn: fetchWikilinkGraph,
    staleTime: 5 * 60 * 1000,
  });
  const data = dataQ.data;

  useEffect(() => {
    if (!data || !mountRef.current) return;
    // An empty scene is a legitimate answer, and it is rendered as WORDS
    // below, not as an empty canvas. Building a force graph over zero nodes
    // would put a black rectangle where the explanation belongs.
    if (data.nodes.length === 0) return;
    const mount = mountRef.current;
    let disposed = false;

    void (async () => {
      const [{ default: ForceGraph3D }, THREE, { UnrealBloomPass }] =
        await Promise.all([
          import("3d-force-graph"),
          import("three"),
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
        ]);
      if (disposed) return;

      const maxDegree = Math.max(1, ...data.nodes.map((x) => x.degree));

      const graph = new ForceGraph3D(mount)
        .backgroundColor("#050508")
        .width(mount.clientWidth)
        .height(mount.clientHeight)
        .graphData({
          nodes: data.nodes.map((x) => ({ ...x })),
          links: data.links.map((l) => ({ ...l })),
        })
        .nodeLabel((raw: object) => {
          const node = raw as WikilinkNode;
          const state = node.resolved
            ? node.vault_path
            : "unresolved — no note with this name exists yet";
          return `<div style="font-family:monospace;font-size:11px;color:#cdc3d7;background:#0b0b10cc;border:1px solid ${
            node.resolved ? "#2a2440" : "#4a3a1e"
          };border-radius:6px;padding:4px 8px">${node.label}<br/><span style="color:#8f86a3">${node.degree} links · ${state}</span></div>`;
        })
        .nodeThreeObject((raw: object) => {
          const node = raw as WikilinkNode;
          // Unresolved nodes are deliberately smaller and dimmer: present and
          // countable, but not competing with real notes for attention.
          const scale = node.resolved ? 1 : 0.62;
          const r = (2.2 + 4.5 * Math.sqrt(node.degree / maxDegree)) * scale;
          const color = new THREE.Color(colorFor(node));
          const mat = new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: node.resolved ? 1.7 : 0.55,
            roughness: 0.35,
            metalness: 0.1,
            transparent: true,
            opacity: node.resolved ? 0.94 : 0.5,
          });
          return new THREE.Mesh(new THREE.SphereGeometry(r, 16, 16), mat);
        })
        .linkColor(() => "rgba(150,130,255,0.30)")
        .linkOpacity(0.3)
        .linkDirectionalParticles(data.links.length < 2500 ? 1 : 0)
        .linkDirectionalParticleSpeed(0.004)
        .linkDirectionalParticleWidth(1.4)
        .onNodeClick((raw: object) => setPicked(raw as WikilinkNode))
        .onBackgroundClick(() => setPicked(null));

      // The luminescence: bloom over the whole scene.
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(mount.clientWidth, mount.clientHeight),
        1.6, // strength
        0.7, // radius
        0.08, // threshold — emissive spheres glow, background stays black
      );
      graph.postProcessingComposer().addPass(bloom);

      // Slow ambient rotation until Konrad grabs the camera.
      const controls = graph.controls() as {
        autoRotate?: boolean;
        autoRotateSpeed?: number;
        addEventListener?: (ev: string, cb: () => void) => void;
      };
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.55;
      controls.addEventListener?.("start", () => {
        controls.autoRotate = false;
      });

      graphRef.current = graph as unknown as { _destructor?: () => void };

      const ro = new ResizeObserver(() => {
        graph.width(mount.clientWidth).height(mount.clientHeight);
      });
      ro.observe(mount);
      (graphRef.current as { __ro?: ResizeObserver }).__ro = ro;
    })();

    return () => {
      disposed = true;
      const g = graphRef.current as
        | { _destructor?: () => void; __ro?: ResizeObserver }
        | null;
      g?.__ro?.disconnect();
      g?._destructor?.();
      graphRef.current = null;
      mount.replaceChildren();
    };
  }, [data]);

  const chipBase = {
    position: "absolute" as const,
    background: "#0b0b10ee",
    border: `1px solid ${tokens.borderSoft}`,
    borderRadius: 6,
  };

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />

      {/* ── THE COUNTS RAIL (R33) ─────────────────────────────────────────
          Every figure names what it counts. The old chip read
          `${stats.nodes} entities · ${stats.links} relations` from a state
          variable set inside the async render effect — so if the effect had
          not run yet it read "no graph yet — index the vault" whether or not
          there was a graph. These read from the response. */}
      <div
        className="mono"
        style={{
          ...chipBase,
          top: 12,
          left: 14,
          maxWidth: 460,
          fontSize: 10,
          lineHeight: 1.65,
          color: tokens.textFaint,
          padding: "7px 11px",
          pointerEvents: "none",
        }}
      >
        {dataQ.isLoading && <div>weaving the net…</div>}
        {dataQ.isError && (
          <div style={{ color: tokens.stuck }}>
            graph unavailable —{" "}
            {dataQ.error instanceof Error
              ? dataQ.error.message
              : String(dataQ.error)}
          </div>
        )}
        {data && (
          <>
            <div style={{ color: tokens.textHi }}>
              {data.nodes.length} nodes drawn · {data.counts.links_total} edges
              drawn
            </div>
            <div>
              {data.counts.notes_scanned} notes scanned ·{" "}
              {data.counts.notes_with_links} notes carrying links
            </div>
            <div>
              <span style={{ color: UNRESOLVED_COLOR }}>
                {data.counts.unresolved_targets} unresolved targets
              </span>{" "}
              · {data.counts.self_links_dropped} self-links dropped
            </div>
            <div style={{ color: tokens.textGhost }}>
              source: {data.source} · measured at {data.measured_at}
            </div>
          </>
        )}
      </div>

      {/* ── THE EMPTY STATE (R35) ─────────────────────────────────────────
          Keyed on `data.nodes.length === 0`, NOT on the truthiness of `data`:
          a response object is truthy even when it describes nothing, which is
          how an empty state gets skipped and a black rectangle ships. The text
          is the SERVER'S, naming the table it read and the rows it found —
          this component does not guess at a cause. */}
      {data && data.nodes.length === 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 40px",
          }}
        >
          <div
            className="mono"
            style={{
              maxWidth: 620,
              fontSize: 11.5,
              lineHeight: 1.8,
              color: tokens.textMuted,
              border: `1px solid ${tokens.borderSoft}`,
              borderRadius: 10,
              padding: "20px 24px",
              background: "#0b0b10ee",
            }}
          >
            <div
              style={{
                color: tokens.warn,
                letterSpacing: "0.1em",
                fontSize: 9.5,
                marginBottom: 8,
              }}
            >
              NO GRAPH TO DRAW — AND THIS IS WHY
            </div>
            {data.empty_reason ?? (
              <span>
                The server returned {data.nodes.length} nodes and no
                empty_reason, which it is contracted to send whenever the node
                list is empty. Read GET /api/memory/graph directly.
              </span>
            )}
          </div>
        </div>
      )}

      {/* picked-node panel */}
      {picked && (
        <div
          className="slidein"
          style={{
            ...chipBase,
            top: 12,
            right: 14,
            width: 280,
            maxHeight: "70%",
            overflowY: "auto",
            border: `1px solid ${tokens.borderEmphasis}`,
            borderRadius: 10,
            padding: "14px 16px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 4,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: colorFor(picked),
                boxShadow: `0 0 8px ${colorFor(picked)}`,
                flex: "none",
              }}
            />
            <span
              style={{ fontSize: 13.5, color: tokens.textHi, fontWeight: 500 }}
            >
              {picked.label}
            </span>
          </div>
          <div
            className="mono"
            style={{ fontSize: 9.5, color: tokens.textFaint, marginBottom: 4 }}
          >
            {picked.degree} links · appears in {picked.notes.length} notes
          </div>

          {/* R34 — the unresolved node says what it is, in words, rather than
              being a differently-coloured dot nobody can decode. */}
          {picked.resolved ? (
            <div
              className="mono"
              style={{
                fontSize: 9.5,
                color: tokens.textGhost,
                marginBottom: 10,
                wordBreak: "break-all",
              }}
            >
              {picked.vault_path}
            </div>
          ) : (
            <div
              className="mono"
              style={{
                fontSize: 9.5,
                color: UNRESOLVED_COLOR,
                lineHeight: 1.6,
                marginBottom: 10,
              }}
            >
              Unresolved: notes link to this name but no note has it. A note you
              meant to write — kept in the graph on purpose, not dropped.
            </div>
          )}

          {picked.notes.map((slug) => (
            <div
              key={slug}
              onClick={() => onSelectNote(slug)}
              className="mono"
              style={{
                fontSize: 10.5,
                color: tokens.decide,
                background: "#0e0c14",
                border: "1px solid #221d33",
                borderRadius: 5,
                padding: "5px 9px",
                marginBottom: 6,
                cursor: "pointer",
                wordBreak: "break-all",
              }}
            >
              {slug}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
