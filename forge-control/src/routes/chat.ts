import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  listRuns,
  getRun,
  createRun,
  appendMessage,
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
 * the rail. limit/offset page the rail — default 30 + "load more". */
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
  return c.json({ count: runs.length, runs, counts, hasMore });
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
      if (!run) {
        await stream.writeSSE({ event: "gone", data: "{}" });
        break;
      }
      const key = `${run.status}:${run.thread.length}:${run.updated_at}`;
      if (key !== lastKey) {
        lastKey = key;
        lastPing = Date.now();
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({ run }),
        });
      } else if (Date.now() - lastPing > 15_000) {
        lastPing = Date.now();
        await stream.writeSSE({ event: "ping", data: String(Date.now()) });
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
  };
  const content = (body.content ?? "").trim();
  if (!content) return c.json({ error: "content required" }, 400);
  const role = body.role === "system" ? "system" : "user";
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
