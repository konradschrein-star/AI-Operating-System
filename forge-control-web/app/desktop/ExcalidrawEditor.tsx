"use client";

/**
 * The Excalidraw editor and its 144 KB stylesheet, isolated in one module so
 * that BOTH leave `/desktop`'s critical path.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * `@excalidraw/excalidraw/index.css` is 144,615 bytes (1,230 occurrences of
 * `excalidraw` — it is the editor's stylesheet). It used to be imported at
 * MODULE SCOPE by `CanvasPane`, and `ChatSurface` imports `CanvasPane`
 * statically, so webpack welded that stylesheet into the desktop bundle even
 * though the editor component itself was already dynamic. Round 801 measured
 * the consequence: the sheet loads on every `/desktop` visit in all four
 * measured scenarios — including the one where the editor never mounts at all.
 * Every visitor who never draws paid for it, on every load.
 *
 * A CSS import only leaves the critical path if the MODULE holding it is
 * reachable exclusively through an async boundary. `CanvasPane` is not: it is
 * statically imported by both `ChatSurface` and the standalone `/canvas` page.
 * So the boundary moves here instead — this module is reached only via
 * `import("./ExcalidrawEditor")` inside CanvasPane's dynamic loader, which puts
 * the component and its stylesheet in the same async chunk.
 *
 * ── WHY NOT JUST MAKE CanvasPane ITSELF DYNAMIC ───────────────────────────
 *
 * That was tried first and rejected on mechanism, before measuring: it would
 * put the editor bundle BEHIND a second chunk. CanvasPane is what calls the
 * preloader, so nothing could start the 350 KB editor download until
 * CanvasPane's own chunk had landed — reintroducing exactly the serialisation
 * that round 801 named as cause #3 and that this round exists to remove, only
 * one level further out. Splitting here gets the page-load win with no new
 * serialisation on the open path.
 *
 * Nothing else belongs in this file. It is a boundary, not a component.
 */

import "@excalidraw/excalidraw/index.css";

export { Excalidraw } from "@excalidraw/excalidraw";
