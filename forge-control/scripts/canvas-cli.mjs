#!/usr/bin/env node
/**
 * canvas — on-box CLI for driving the Excalidraw canvas from a shell.
 *
 * WHY THIS EXISTS (from Planning System Design.md):
 *   The blunt HTTP PUT requires shipping the full elements[] every write —
 *   ~27k tokens for a real board. This CLI wraps element-level ops
 *   (POST /api/canvas/patch) so adding a card costs ~500 tokens instead.
 *   It talks to forge-control over local HTTP (not the vault directly), so
 *   the mtime conflict guard and SSE notifications stay uniform across
 *   every writer: browser tab, agent, and shell.
 *
 * USAGE:
 *   canvas list [-q <query>]
 *   canvas show <path>                            → semantic text projection
 *   canvas add-box <path> --label X [--x N --y N --color #hex]
 *   canvas add-text <path> --text X [--x N --y N --size 20]
 *   canvas connect <path> <idOrLabel> <idOrLabel> [--label X]
 *   canvas remove  <path> <idOrLabel>
 *   canvas open    <path|query> [--reason "why"]  → parks an intent
 *   canvas new     <name> [--folder Excalidraw]
 *
 * Exit codes:
 *   0 = ok, 1 = usage error, 2 = HTTP error, 3 = conflict (409)
 */

import { argv, exit, stdout, stderr } from "node:process";

const BASE = process.env.FORGE_CONTROL_URL ?? "http://127.0.0.1:7700";

function usage(msg) {
  if (msg) stderr.write(`canvas: ${msg}\n\n`);
  stderr.write(`Usage:
  canvas list [-q <query>]
  canvas show <path>
  canvas add-box <path> --label X [--x N --y N --w N --h N --color #hex]
  canvas add-text <path> --text X [--x N --y N --size N]
  canvas connect <path> <idOrLabel> <idOrLabel> [--label X]
  canvas remove  <path> <idOrLabel>
  canvas open    <path|query> [--reason "why"]
  canvas new     <name> [--folder Excalidraw]
`);
  exit(1);
}

// ------- HTTP helpers ------------------------------------------------------

async function api(method, path, body) {
  const url = BASE + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    stderr.write(`canvas: connection error to ${url}: ${e.message}\n`);
    exit(2);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const detail = json?.detail ?? json?.error ?? text.slice(0, 200);
    stderr.write(`canvas: ${res.status} ${res.statusText} → ${detail}\n`);
    exit(res.status === 409 ? 3 : 2);
  }
  return json;
}

// ------- CLI argument parsing ---------------------------------------------

function parseFlags(args, spec) {
  // spec: { flag: "string"|"number"|"boolean" }
  const out = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const kind = spec[name];
      if (!kind) usage(`unknown flag --${name}`);
      if (kind === "boolean") {
        out[name] = true;
      } else {
        const v = args[++i];
        if (v === undefined) usage(`flag --${name} needs a value`);
        out[name] = kind === "number" ? Number(v) : v;
      }
    } else if (a === "-q") {
      const v = args[++i];
      if (v === undefined) usage("-q needs a value");
      out.q = v;
    } else {
      positional.push(a);
    }
  }
  return { flags: out, positional };
}

// ------- Semantic projection (mirrors lib/canvas-context.ts) --------------

/** Reduce raw elements to a readable line list — the same shape the agent
 *  gets in-conversation. `show` runs this against a live file rather than
 *  reusing the server module, so this CLI can run independently.
 *  Keep in sync with lib/canvas-context.ts: renderFull(). */
function renderFull(path, elements) {
  const live = (elements ?? []).filter((e) => !e?.isDeleted);
  if (!live.length) return `[CANVAS: ${path}]\nEmpty.`;

  const boundLabel = new Map();
  for (const e of live) {
    if (e.type === "text" && e.containerId) {
      boundLabel.set(e.containerId, String(e.text ?? ""));
    }
  }
  const labelOf = new Map();
  for (const e of live) {
    const own = e.type === "text" ? String(e.text ?? "") : "";
    const label = boundLabel.get(e.id) ?? own;
    labelOf.set(e.id, short(label, 40));
  }
  const rows = [];
  for (const e of live) {
    if (e.type === "text" && e.containerId) continue;
    const label = short(boundLabel.get(e.id) ?? (e.type === "text" ? String(e.text ?? "") : ""));
    if (e.type === "arrow" || e.type === "line") {
      const from = labelOf.get(e.startBinding?.elementId) ?? "?";
      const to = labelOf.get(e.endBinding?.elementId) ?? "?";
      rows.push({ kind: e.type, id: e.id, label: `${from} → ${to}`, x: e.x, y: e.y });
    } else {
      rows.push({ kind: e.type, id: e.id, label, x: e.x, y: e.y });
    }
  }
  const lines = [
    `[CANVAS: ${path}]`,
    `${rows.length} element(s):`,
    ...rows.map(
      (r) =>
        `  ${r.id.slice(0, 8).padEnd(8)}  ${r.kind.padEnd(9)}  ${
          r.label ? `"${r.label}"` : `(at ${Math.round(r.x)},${Math.round(r.y)})`
        }`,
    ),
  ];
  return lines.join("\n");
}

function short(s, max = 80) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ------- Element lookup: id OR label match --------------------------------

function findElementId(elements, needle) {
  // Exact id first — the addressable case.
  const byExactId = elements.find((e) => e.id === needle);
  if (byExactId) return byExactId.id;
  // Prefix id — hand-typed short ids from `canvas show` output.
  const byPrefixId = elements.find((e) => typeof e.id === "string" && e.id.startsWith(needle));
  if (byPrefixId) return byPrefixId.id;
  // Bound label — the "connect Ops-console -> Orchestrator" case.
  const q = needle.toLowerCase();
  const boundText = new Map();
  for (const e of elements) {
    if (e.type === "text" && e.containerId) {
      boundText.set(e.containerId, String(e.text ?? "").toLowerCase());
    }
  }
  const labelHit = elements.find((e) => {
    const bl = boundText.get(e.id);
    if (bl && (bl === q || bl.includes(q))) return true;
    if (e.type === "text" && typeof e.text === "string") {
      const et = e.text.toLowerCase();
      if (et === q || et.includes(q)) return true;
    }
    return false;
  });
  return labelHit?.id ?? null;
}

// ------- Auto-placement: grid-flow below existing content -----------------

/** Sit the new box under the lowest element in its column band, or start a
 *  new column if the current one is packed. Deterministic on `count` so
 *  repeated calls fan out cleanly instead of piling up. */
function autoPlace(elements, count = 0, w = 220, h = 100) {
  const GUTTER = 40;
  const COL_W = w + GUTTER;
  const ROW_H = h + GUTTER;
  if (!elements.length) {
    return { x: 80 + count * COL_W, y: 80 };
  }
  let maxY = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const e of elements) {
    if (!e || e.type === "arrow" || e.type === "line" || e.isDeleted) continue;
    const y = (e.y ?? 0) + (e.height ?? 0);
    if (y > maxY) maxY = y;
    if ((e.x ?? 0) < minX) minX = e.x ?? 0;
    if ((e.x ?? 0) + (e.width ?? 0) > maxX) maxX = (e.x ?? 0) + (e.width ?? 0);
  }
  if (!Number.isFinite(minX)) minX = 80;
  return { x: minX + count * COL_W, y: maxY + GUTTER };
}

// ------- Subcommands ------------------------------------------------------

async function cmdList(args) {
  const { flags } = parseFlags(args, {});
  const { items } = await api("GET", "/api/canvas/list");
  const filtered = flags.q
    ? items.filter(
        (i) =>
          i.name.toLowerCase().includes(flags.q.toLowerCase()) ||
          i.folder.toLowerCase().includes(flags.q.toLowerCase()),
      )
    : items;
  for (const i of filtered.slice(0, 100)) {
    const age = Math.round((Date.now() - i.mtime) / 60000);
    stdout.write(`${String(age).padStart(6)}m  ${i.path}\n`);
  }
}

async function cmdShow(args) {
  const { positional } = parseFlags(args, {});
  if (positional.length !== 1) usage("show requires <path>");
  const path = positional[0];
  const doc = await api(
    "GET",
    `/api/canvas/file?path=${encodeURIComponent(path)}`,
  );
  stdout.write(renderFull(path, doc.elements) + "\n");
}

async function cmdAddBox(args) {
  const { flags, positional } = parseFlags(args, {
    label: "string",
    x: "number",
    y: "number",
    w: "number",
    h: "number",
    color: "string",
  });
  if (positional.length !== 1) usage("add-box requires <path>");
  if (!flags.label) usage("add-box requires --label");
  const path = positional[0];
  const doc = await api(
    "GET",
    `/api/canvas/file?path=${encodeURIComponent(path)}`,
  );
  const w = flags.w ?? 220;
  const h = flags.h ?? 100;
  const pos =
    flags.x !== undefined && flags.y !== undefined
      ? { x: flags.x, y: flags.y }
      : autoPlace(doc.elements, 0, w, h);
  const box = {
    type: "rectangle",
    x: pos.x,
    y: pos.y,
    width: w,
    height: h,
    strokeColor: flags.color ?? "#1e1e1e",
  };
  const label = {
    type: "text",
    x: pos.x + 8,
    y: pos.y + h / 2 - 12,
    width: w - 16,
    height: 24,
    text: flags.label,
    originalText: flags.label,
    fontSize: 20,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    lineHeight: 1.25,
    autoResize: false,
  };
  // First patch: create the box so we get its id back.
  const boxRes = await api("POST", "/api/canvas/patch", {
    path,
    baseMtime: doc.mtime,
    ops: [{ op: "add", elements: [box] }],
  });
  const boxId = boxRes.added[0];
  // Second patch: create the label with containerId=box and bind it back.
  const labelWithContainer = { ...label, containerId: boxId };
  const labelRes = await api("POST", "/api/canvas/patch", {
    path,
    baseMtime: boxRes.mtime,
    ops: [
      { op: "add", elements: [labelWithContainer] },
    ],
  });
  const labelId = labelRes.added[0];
  // Third patch: bind the label to the box's boundElements so it renders inside.
  await api("POST", "/api/canvas/patch", {
    path,
    baseMtime: labelRes.mtime,
    ops: [
      {
        op: "update",
        id: boxId,
        patch: { boundElements: [{ id: labelId, type: "text" }] },
      },
    ],
  });
  stdout.write(`added box ${boxId} "${flags.label}"\n`);
}

async function cmdAddText(args) {
  const { flags, positional } = parseFlags(args, {
    text: "string",
    x: "number",
    y: "number",
    size: "number",
  });
  if (positional.length !== 1) usage("add-text requires <path>");
  if (!flags.text) usage("add-text requires --text");
  const path = positional[0];
  const doc = await api(
    "GET",
    `/api/canvas/file?path=${encodeURIComponent(path)}`,
  );
  const size = flags.size ?? 20;
  const width = Math.max(60, flags.text.length * size * 0.55);
  const height = Math.max(size * 1.4, 30);
  const pos =
    flags.x !== undefined && flags.y !== undefined
      ? { x: flags.x, y: flags.y }
      : autoPlace(doc.elements, 0, width, height);
  const res = await api("POST", "/api/canvas/patch", {
    path,
    baseMtime: doc.mtime,
    ops: [
      {
        op: "add",
        elements: [
          {
            type: "text",
            x: pos.x,
            y: pos.y,
            width,
            height,
            text: flags.text,
            originalText: flags.text,
            fontSize: size,
            fontFamily: 1,
            textAlign: "left",
            verticalAlign: "top",
            lineHeight: 1.25,
            autoResize: true,
          },
        ],
      },
    ],
  });
  stdout.write(`added text ${res.added[0]} "${flags.text}"\n`);
}

async function cmdConnect(args) {
  const { flags, positional } = parseFlags(args, { label: "string" });
  if (positional.length !== 3) usage("connect requires <path> <from> <to>");
  const [path, fromRaw, toRaw] = positional;
  const doc = await api(
    "GET",
    `/api/canvas/file?path=${encodeURIComponent(path)}`,
  );
  const fromId = findElementId(doc.elements, fromRaw);
  const toId = findElementId(doc.elements, toRaw);
  if (!fromId) return usage(`connect: no element matches "${fromRaw}"`);
  if (!toId) return usage(`connect: no element matches "${toRaw}"`);
  const res = await api("POST", "/api/canvas/patch", {
    path,
    baseMtime: doc.mtime,
    ops: [
      {
        op: "connect",
        fromId,
        toId,
        ...(flags.label ? { label: flags.label } : {}),
      },
    ],
  });
  stdout.write(
    `connected ${fromId.slice(0, 8)} → ${toId.slice(0, 8)} (arrow ${res.added[0].slice(0, 8)})\n`,
  );
}

async function cmdRemove(args) {
  const { positional } = parseFlags(args, {});
  if (positional.length !== 2) usage("remove requires <path> <idOrLabel>");
  const [path, needle] = positional;
  const doc = await api(
    "GET",
    `/api/canvas/file?path=${encodeURIComponent(path)}`,
  );
  const id = findElementId(doc.elements, needle);
  if (!id) return usage(`remove: no element matches "${needle}"`);
  // If it's a container with a bound text label, remove both — otherwise the
  // orphaned label sits at (x,y) with no shape around it, which reads as junk.
  const target = doc.elements.find((e) => e.id === id);
  const ids = [id];
  if (target?.boundElements) {
    for (const b of target.boundElements) {
      if (b?.type === "text" && b.id) ids.push(b.id);
    }
  }
  await api("POST", "/api/canvas/patch", {
    path,
    baseMtime: doc.mtime,
    ops: [{ op: "remove", ids }],
  });
  stdout.write(`removed ${ids.length} element(s)\n`);
}

async function cmdOpen(args) {
  const { flags, positional } = parseFlags(args, { reason: "string" });
  if (positional.length !== 1) usage("open requires <path|query>");
  const target = positional[0];
  const body = target.endsWith(".excalidraw.md")
    ? { path: target, ...(flags.reason ? { reason: flags.reason } : {}) }
    : { query: target, ...(flags.reason ? { reason: flags.reason } : {}) };
  const res = await api("POST", "/api/canvas/open", body);
  stdout.write(`open intent parked: ${res.path} (seq ${res.seq})\n`);
}

async function cmdNew(args) {
  const { flags, positional } = parseFlags(args, { folder: "string" });
  if (positional.length !== 1) usage("new requires <name>");
  const res = await api("POST", "/api/canvas/new", {
    name: positional[0],
    ...(flags.folder ? { folder: flags.folder } : {}),
  });
  stdout.write(`created ${res.path}\n`);
}

// ------- Entry ------------------------------------------------------------

const [cmd, ...rest] = argv.slice(2);

const commands = {
  list: cmdList,
  show: cmdShow,
  "add-box": cmdAddBox,
  "add-text": cmdAddText,
  connect: cmdConnect,
  remove: cmdRemove,
  open: cmdOpen,
  new: cmdNew,
};

if (!cmd || cmd === "-h" || cmd === "--help") usage();
const fn = commands[cmd];
if (!fn) usage(`unknown command: ${cmd}`);
try {
  await fn(rest);
} catch (e) {
  stderr.write(`canvas: ${e.message ?? e}\n`);
  exit(2);
}
