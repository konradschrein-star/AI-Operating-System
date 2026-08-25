/**
 * THOUGHTS surface — Konrad's idea pool, quotes and dreams (PLAN.md §4.3).
 * A thin Hono layer over lib/thoughts.ts; every field-shaped decision (what
 * counts as a valid area, what CAS means, what a move is) lives there so it
 * stays testable without an HTTP server.
 *
 *   GET    /api/thoughts?view=unexecuted|area|importance|executed&area=…
 *   POST   /api/thoughts/ideas        {idea,area,importance?,description?,why_genius?,status?}
 *   PATCH  /api/thoughts/ideas        {path,base_sha256,…fields}
 *   POST   /api/thoughts/ideas/adopt  {path}
 *   POST   /api/thoughts/quotes       {text,source?}
 *   POST   /api/thoughts/dreams       {text}
 */

import { Hono, type Context } from "hono";

import {
  listIdeas,
  createIdeaFile,
  updateIdea,
  adoptIdea,
  addQuote,
  listQuotes,
  addDream,
  listDreams,
  ThoughtsValidationError,
  VaultConflictError,
} from "../lib/thoughts.ts";

const r = new Hono();

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}

async function readJsonObject(
  c: Context,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch (e) {
    return { ok: false, error: `invalid json: ${describe(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `invalid json: body must be a JSON object, received ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}`,
    };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** GET / — the pool: ideas (viewed), quotes, dreams. */
r.get("/", async (c) => {
  const view = c.req.query("view") ?? undefined;
  const area = c.req.query("area") ?? undefined;
  try {
    const [{ ideas, errors, layout }, quotes, dreams] = await Promise.all([
      listIdeas({ view, area }),
      listQuotes(),
      listDreams(),
    ]);
    return c.json({ ideas, errors, quotes, dreams, layout });
  } catch (e) {
    if (e instanceof ThoughtsValidationError) {
      return c.json({ error: e.message, field: e.field }, 400);
    }
    const msg = describe(e);
    console.error("[thoughts/list]", msg);
    return c.json({ error: msg }, 500);
  }
});

/** POST /ideas — always Konrad's side (source: konrad, author: konrad); an
 *  agent-derived seed is only ever written by scripts/seed-thoughts.ts. */
r.post("/ideas", async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  try {
    const idea = await createIdeaFile({
      idea: body.idea,
      area: body.area,
      importance: body.importance,
      description: body.description,
      why_genius: body.why_genius,
      status: body.status,
      author: "konrad",
      source: "konrad",
    });
    return c.json({ idea }, 201);
  } catch (e) {
    if (e instanceof ThoughtsValidationError) {
      return c.json({ error: e.message, field: e.field }, 400);
    }
    const msg = describe(e);
    console.error("[thoughts/ideas:post]", msg);
    return c.json({ error: msg }, 500);
  }
});

/** PATCH /ideas — compare-and-swap edit of an existing idea/seed file. */
r.patch("/ideas", async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  try {
    const idea = await updateIdea({
      path: body.path,
      base_sha256: body.base_sha256,
      idea: body.idea,
      area: body.area,
      importance: body.importance,
      status: body.status,
      description: body.description,
      why_genius: body.why_genius,
    });
    return c.json({ idea });
  } catch (e) {
    if (e instanceof VaultConflictError) {
      console.error("[thoughts/ideas:patch]", e.message);
      return c.json({ error: e.message, current_sha256: e.currentSha256 }, 409);
    }
    if (e instanceof ThoughtsValidationError) {
      return c.json({ error: e.message, field: e.field }, 400);
    }
    if (isEnoent(e)) {
      const p = typeof body.path === "string" ? body.path : "";
      return c.json({ error: `no such idea: ${p}`, path: p }, 404);
    }
    const msg = describe(e);
    console.error("[thoughts/ideas:patch]", msg);
    return c.json({ error: msg }, 500);
  }
});

/** POST /ideas/adopt — move a Forge seed to Thoughts/Ideas/ (the correction). */
r.post("/ideas/adopt", async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  try {
    const idea = await adoptIdea(body.path);
    return c.json({ idea });
  } catch (e) {
    if (e instanceof ThoughtsValidationError) {
      return c.json({ error: e.message, field: e.field }, 400);
    }
    if (isEnoent(e)) {
      const p = typeof body.path === "string" ? body.path : "";
      return c.json({ error: `no such seed: ${p}`, path: p }, 404);
    }
    const msg = describe(e);
    console.error("[thoughts/ideas/adopt:post]", msg);
    return c.json({ error: msg }, 500);
  }
});

/** POST /quotes — append-only. */
r.post("/quotes", async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  try {
    const quote = await addQuote({ text: body.text, source: body.source });
    return c.json({ quote }, 201);
  } catch (e) {
    if (e instanceof ThoughtsValidationError) {
      return c.json({ error: e.message, field: e.field }, 400);
    }
    const msg = describe(e);
    console.error("[thoughts/quotes:post]", msg);
    return c.json({ error: msg }, 500);
  }
});

/** POST /dreams — append-only, no source. */
r.post("/dreams", async (c) => {
  const parsed = await readJsonObject(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const body = parsed.body;
  try {
    const dream = await addDream({ text: body.text });
    return c.json({ dream }, 201);
  } catch (e) {
    if (e instanceof ThoughtsValidationError) {
      return c.json({ error: e.message, field: e.field }, 400);
    }
    const msg = describe(e);
    console.error("[thoughts/dreams:post]", msg);
    return c.json({ error: msg }, 500);
  }
});

export default r;
