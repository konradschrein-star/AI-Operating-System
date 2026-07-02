"use client";

/**
 * v2.2 — luminescent 3D net of the second brain.
 *
 * Entities from knowledge_triples rendered as emissive spheres with an
 * UnrealBloom pass over the whole scene; links are the triple edges with
 * slow directional particles so the graph reads as alive. Click a node →
 * side panel with its notes → click through to the note reader.
 *
 * 3d-force-graph touches `window` at module scope, so it is imported
 * dynamically inside useEffect — never at the top level (Next SSR build).
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { tokens } from "../tokens";
import { fetchMemoryGraph, type GraphNode } from "../api";

/** Deterministic luminescent palette — violet/cyan/magenta band. */
function nodeColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = 190 + (h % 140); // 190..330 — cyan → violet → magenta
  const sat = 78 + (h % 18);
  const light = 58 + ((h >> 3) % 14);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

export function MemoryGraph3D({
  onSelectNote,
}: {
  onSelectNote: (slug: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<{ _destructor?: () => void } | null>(null);
  const [picked, setPicked] = useState<GraphNode | null>(null);
  const [stats, setStats] = useState<{ nodes: number; links: number } | null>(
    null,
  );

  const dataQ = useQuery({
    queryKey: ["memory", "graph"],
    queryFn: fetchMemoryGraph,
    staleTime: 5 * 60 * 1000,
  });
  const data = dataQ.data;

  useEffect(() => {
    if (!data || !mountRef.current) return;
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

      const maxDegree = Math.max(1, ...data.nodes.map((n) => n.degree));

      const graph = new ForceGraph3D(mount)
        .backgroundColor("#050508")
        .width(mount.clientWidth)
        .height(mount.clientHeight)
        .graphData({
          nodes: data.nodes.map((n) => ({ ...n })),
          links: data.links.map((l) => ({ ...l })),
        })
        .nodeLabel(
          (n: object) =>
            `<div style="font-family:monospace;font-size:11px;color:#cdc3d7;background:#0b0b10cc;border:1px solid #2a2440;border-radius:6px;padding:4px 8px">${(n as GraphNode).label}<br/><span style="color:#8f86a3">${(n as GraphNode).degree} connections</span></div>`,
        )
        .nodeThreeObject((n: object) => {
          const node = n as GraphNode;
          const r = 2.2 + 4.5 * Math.sqrt(node.degree / maxDegree);
          const color = new THREE.Color(nodeColor(node.id));
          const mat = new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 1.7,
            roughness: 0.35,
            metalness: 0.1,
            transparent: true,
            opacity: 0.94,
          });
          return new THREE.Mesh(new THREE.SphereGeometry(r, 16, 16), mat);
        })
        .linkColor(() => "rgba(150,130,255,0.30)")
        .linkOpacity(0.3)
        .linkDirectionalParticles(data.links.length < 2500 ? 1 : 0)
        .linkDirectionalParticleSpeed(0.004)
        .linkDirectionalParticleWidth(1.4)
        .onNodeClick((n: object) => setPicked(n as GraphNode))
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
      setStats({ nodes: data.nodes.length, links: data.links.length });

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

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />

      {/* status chip */}
      <div
        className="mono"
        style={{
          position: "absolute",
          top: 12,
          left: 14,
          fontSize: 10,
          color: tokens.textFaint,
          background: "#0b0b10cc",
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 6,
          padding: "4px 9px",
          pointerEvents: "none",
        }}
      >
        {dataQ.isLoading
          ? "weaving the net…"
          : stats
            ? `${stats.nodes} entities · ${stats.links} relations`
            : "no graph yet — index the vault"}
      </div>

      {/* picked-entity panel */}
      {picked && (
        <div
          className="slidein"
          style={{
            position: "absolute",
            top: 12,
            right: 14,
            width: 260,
            maxHeight: "70%",
            overflowY: "auto",
            background: "#0b0b10ee",
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
                background: nodeColor(picked.id),
                boxShadow: `0 0 8px ${nodeColor(picked.id)}`,
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
            style={{ fontSize: 9.5, color: tokens.textFaint, marginBottom: 10 }}
          >
            {picked.degree} connections · {picked.notes.length} notes
          </div>
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
