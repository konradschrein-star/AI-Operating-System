import { Hono } from "hono";
import {
  loadCanvas,
  renderDelta,
  type CanvasSnapshot,
} from "../lib/canvas-context.ts";
import { streamSSE } from "hono/streaming";
import {
  listRuns,
  getRun,
  createRun,
  appendMessage,
  setRunCanvas,
  setRunCanvasSnapshot,
  setRunStatus,
  setRunModel,
  setRunEffort,
  runCounts,
  archiveRun,
  archiveAllRuns,
  searchRuns,
  type RunStatus,
} from "../db/runs.ts";
import { sanitizeEffort } from "../lib/cc-runner.ts";
/* phase 300g (U2/U3) — chat↔project linkage. All SQL lives in chat-linkage.ts;
 * this file only calls it. See that module for the scan bounds and the
 * backfill's idempotence guarantee. */
import {
  resolveChatProject,
  rollupChatProjects,
} from "./chat-linkage.ts";

const r = new Hono();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "paused",
  "stuck",
  "completed",
  "failed",
  "cancelled",
]);

/* List threads (newest first, archived excluded) plus counts by status for
 * the rail. limit/offset page the rail — default 30 + "load more".
 *
 * U3 (phase 300g): each run that owns a coding project also carries
 * `project_id`, `project_status`, `tasks_done`, `tasks_total` so the rail can
 * render "x/y tasks" next to the status dot. Additive and OPTIONAL: a chat
 * with no project has the four fields ABSENT — not zeroed. `tasks_done: 0,
 * tasks_total: 0` would render as a real progress badge on a chat that never
 * started a project, which is precisely the kind of confident-looking lie
 * this phase exists to remove.
 *
 * Request cost is O(1) in page size: one listRuns, one runCounts, one grouped
 * rollup query for the whole page — no per-row query, and no thread scan
 * (that is the detail path's job; see chat-linkage.ts). CONSEQUENCE: chats
 * created before `origin_chat_id` existed show no x/y in the rail until they
 * are opened once, because opening a chat is what runs the scan and backfills
 * the link. */
r.get("/", async (c) => {
  const limit = Math.min(
    200,
    Math.max(1, Number(c.req.query("limit") ?? "30")),
  );
  const offset = Math.max(0, Number(c.req.query("offset") ?? "0"));
  const [{ runs, hasMore }, counts] = await Promise.all([
    listRuns(limit, offset),
    runCounts(),
  ]);
  const links = await rollupChatProjects(runs.map((run) => run.id));
  const shaped = runs.map((run) => {
    const link = links.get(run.id);
    return link ? { ...run, ...link } : run;
  });
  return c.json({ count: shaped.length, runs: shaped, counts, hasMore });
});

/* ─── phase 300g (U2): linkage resolution for ONE chat ──────────────────────
 *
 * `GET /api/chat/:id/linkage` → `{chat_id, project_id, project_status,
 * link_source, link_ambiguous}`. Additive endpoint; nothing else changed.
 *
 * This is the detail-path resolver: metadata first, bounded thread scan as
 * fallback, and a one-time idempotent backfill when the scan is unambiguous
 * (chat-linkage.ts owns all three). Round 305's `GET /api/chat/:id/team`
 * calls the same function rather than re-deriving linkage.
 *
 * An unlinked chat — and a chat id that does not exist — answers 200 with
 * `project_id: null`. "No project" is a fact about this chat, not a failure;
 * only a malformed id (400) or a database error (500, via the resolver's
 * throw) is an error. */
r.get("/:id/linkage", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const link = await resolveChatProject(id);
  return c.json({ chat_id: id, ...link });
});

/* Search past chats — title, prompt, and every message in the thread, so a
 * word Konrad typed (or the engine replied with) is enough to find the
 * conversation, not just a title match. Includes closed/archived chats:
 * closing hides a chat from the rail but must never make it unfindable. */
r.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ q, runs: [] });
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "30")));
  const runs = await searchRuns(q, limit);
  return c.json({ q, runs });
});

/* Close every open chat in one shot — archives each and cancels any that
 * were still queued/running/paused/stuck. */
r.post("/archive-all", async (c) => {
  const archived = await archiveAllRuns();
  return c.json({ archived });
});

/* v2.0: live run events. Emits a `snapshot` (full run JSON) immediately
 * and whenever status / thread length / updated_at changes; `ping` keeps
 * proxies from closing the pipe. DB-poll at 1s — the executor streams CC
 * tool events into runs.thread, so this is what makes chat feel alive. */
r.get("/:id/events", (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  return streamSSE(c, async (stream) => {
    let alive = true;
    stream.onAbort(() => {
      alive = false;
    });

    /** Every write races the client disconnecting. `alive` is only updated by
     *  onAbort, which can fire while we're awaiting the DB — so by the time we
     *  write, the stream may already be closed and hono throws
     *  ERR_INVALID_STATE ("ReadableStream is already closed"). That surfaced
     *  as a steady drip of unhandled errors in the API log and could take the
     *  request down. Closing is a normal, expected end to an SSE connection,
     *  not an error: treat a failed write as "client left" and stop cleanly. */
    const send = async (event: string, data: string): Promise<boolean> => {
      if (!alive) return false;
      try {
        await stream.writeSSE({ event, data });
        return true;
      } catch {
        alive = false;
        return false;
      }
    };

    let lastKey = "";
    let lastPing = Date.now();
    while (alive) {
      let run;
      try {
        run = await getRun(id);
      } catch (e) {
        console.error(
          "[chat events] getRun failed:",
          e instanceof Error ? e.message : e,
        );
        await stream.sleep(2_000);
        continue;
      }
      if (!alive) break; // disconnected while we were querying
      if (!run) {
        await send("gone", "{}");
        break;
      }
      const key = `${run.status}:${run.thread.length}:${run.updated_at}`;
      if (key !== lastKey) {
        lastKey = key;
        lastPing = Date.now();
        if (!(await send("snapshot", JSON.stringify({ run })))) break;
      } else if (Date.now() - lastPing > 15_000) {
        lastPing = Date.now();
        if (!(await send("ping", String(Date.now())))) break;
      }
      await stream.sleep(1_000);
    }
  });
});

/* Full thread detail. */
r.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const run = await getRun(id);
  if (!run) return c.json({ error: "run not found" }, 404);
  return c.json({ run });
});

/* New chat. */
r.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    prompt?: string;
    worker?: string;
    budget_usd?: number;
    metadata?: Record<string, unknown>;
  };
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return c.json({ error: "prompt required" }, 400);
  const title = (body.title ?? prompt.split("\n")[0] ?? "untitled")
    .trim()
    .slice(0, 100);
  const run = await createRun({
    title,
    prompt,
    worker: body.worker,
    budget_usd: body.budget_usd,
    metadata: body.metadata,
  });
  return c.json({ run }, 201);
});

/* Append a user message and re-queue for executor pickup. */
r.post("/:id/message", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    content?: string;
    role?: "user" | "system";
    /** Vault-relative path of the drawing open beside the chat, if any. */
    canvas_path?: string;
  };
  const content = (body.content ?? "").trim();
  if (!content) return c.json({ error: "content required" }, 400);
  const role = body.role === "system" ? "system" : "user";

  // Canvas context. The board is sent in full the first time it appears in a
  // conversation, and after that only what changed — an untouched canvas adds
  // nothing to the thread, which is the whole point: these drawings are meant
  // to get huge, and re-sending an unchanged one every turn would burn the
  // context window on geometry nobody asked about.
  const canvasPath = (body.canvas_path ?? "").trim();
  if (canvasPath) {
    const current = await getRun(id);
    if (current) {
      const drawing = await loadCanvas(canvasPath);
      if (drawing) {
        const prev =
          (current.metadata?.canvas_snapshot as CanvasSnapshot | undefined) ??
          null;
        const delta = renderDelta(canvasPath, drawing, prev);
        if (delta.changed) {
          await appendMessage(id, {
            role: "system",
            content: delta.text,
            ts: new Date().toISOString(),
            kind: "text",
          });
        }
        // Snapshot even when unchanged: cheap, and it keeps takenAt honest.
        await setRunCanvasSnapshot(id, delta.snapshot);
      }
    }
  }

  const updated = await appendMessage(
    id,
    {
      role,
      content,
      ts: new Date().toISOString(),
      kind: "text",
    },
    { setStatus: "queued" },
  );
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* Resume a stuck run by appending a continue marker and re-queueing. The
 * marker is a system turn that the executor's buildPromptFromThread will
 * surface as a [SYSTEM] block to Claude — telling it not to repeat what it
 * already produced in the partial assistant turn. v1.6 phase 1.
 */
r.post("/:id/resume", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const current = await getRun(id);
  if (!current) return c.json({ error: "run not found" }, 404);
  if (current.status !== "stuck") {
    return c.json(
      { error: `cannot resume run with status '${current.status}'` },
      409,
    );
  }
  const updated = await appendMessage(
    id,
    {
      role: "system",
      content:
        "[continue marker] Resume from where you stopped. Do not repeat what you already produced; pick up from the last partial assistant turn.",
      ts: new Date().toISOString(),
      kind: "text",
      meta: { continue_marker: true },
    },
    { setStatus: "queued" },
  );
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* v2.1: set the engine model for subsequent turns of this run. Aliases
 * (sonnet/opus/haiku) or full model ids; "default" clears the override. */
r.post("/:id/model", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { model?: string };
  const raw = (body.model ?? "").trim();
  if (!raw) return c.json({ error: "model required" }, 400);
  const model = raw === "default" ? null : raw;
  if (model !== null && !/^[a-z0-9[\]().-]+$/i.test(model)) {
    return c.json({ error: `invalid model: ${raw}` }, 400);
  }
  const updated = await setRunModel(id, model);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* PLAN.md F1: persist the vault-relative path of the drawing open beside this
 * chat. Was in browser localStorage before, which meant a chat opened on the
 * phone didn't know a canvas was pinned to it on the desktop. Empty string or
 * null clears the pin. Path shape is validated the same way the canvas routes
 * validate it — .excalidraw.md, no traversal — because it will be read from
 * this row and passed straight to loadCanvas() next turn. */
r.post("/:id/canvas", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { path?: string | null };
  const raw = body.path;
  let next: string | null;
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    next = null;
  } else if (typeof raw === "string") {
    const p = raw.trim();
    if (!p.endsWith(".excalidraw.md")) {
      return c.json({ error: "path must end with .excalidraw.md" }, 400);
    }
    if (p.includes("..") || p.startsWith("/")) {
      return c.json({ error: "path must be vault-relative" }, 400);
    }
    next = p;
  } else {
    return c.json({ error: "path must be a string or null" }, 400);
  }
  const updated = await setRunCanvas(id, next);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* v2.5: set the reasoning effort for subsequent turns of this run. One of
 * low/medium/high/xhigh/max; "default" clears the override. The web UI caps
 * its own picker at "high" — xhigh/max stay reachable via API/Telegram only. */
r.post("/:id/effort", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { effort?: string };
  const raw = (body.effort ?? "").trim();
  if (!raw) return c.json({ error: "effort required" }, 400);
  const effort = raw === "default" ? null : sanitizeEffort(raw);
  if (raw !== "default" && effort === null) {
    return c.json({ error: `invalid effort: ${raw}` }, 400);
  }
  const updated = await setRunEffort(id, effort);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* Close (archive) a single chat. Cancels it first if it's still doing
 * anything — see archiveRun. Logs are kept, just hidden from the rail. */
r.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const updated = await archiveRun(id);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

/* Status control: pause / resume / cancel. */
r.post("/:id/status", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "invalid run id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const status = (body.status ?? "") as RunStatus;
  if (!VALID_STATUSES.has(status))
    return c.json({ error: `invalid status: ${status}` }, 400);
  const updated = await setRunStatus(id, status);
  if (!updated) return c.json({ error: "run not found" }, 404);
  return c.json({ run: updated });
});

export default r;
