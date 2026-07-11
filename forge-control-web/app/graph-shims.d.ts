/**
 * v2.2 — ambient shims for the 3D graph stack. We deliberately type these
 * as `any`: the graph component uses a handful of methods and keeps its own
 * narrow local types; pulling @types/three for one bloom pass isn't worth it.
 */
declare module "3d-force-graph";
declare module "three";
declare module "three/examples/jsm/postprocessing/UnrealBloomPass.js";

/** v2.5 — @cubone/react-file-manager ships no .d.ts (main points at raw
 *  src/index.js). FileExplorerPanel.tsx keeps its own FMFile type and casts
 *  at the callback boundaries, so `any` here is fine. */
declare module "@cubone/react-file-manager";
