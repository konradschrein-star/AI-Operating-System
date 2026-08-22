/**
 * /api/integrations/cli-auth/* — the four verbs behind the Connect button.
 *
 *   POST /cli-auth/:provider/start   { slug?, config_dir? } → CliAuthStatus
 *   GET  /cli-auth/:provider                                → CliAuthStatus
 *   POST /cli-auth/:provider/code    { code }               → CliAuthStatus
 *   POST /cli-auth/:provider/cancel                         → CliAuthStatus
 *
 * ── THE CODE NEVER TRAVELS IN A URL ──────────────────────────────────────────
 * It arrives in a POST BODY and nowhere else. A query parameter would be
 * written to every access log, every proxy log and the browser's history, and
 * an OAuth code is a bearer credential until it is spent. Nothing in this file
 * logs the body, echoes it on error, or includes it in a thrown message — the
 * same rule `secrets.ts` lives by, for the same reason.
 *
 * Every response is the SAME `CliAuthStatus` shape, including every error. A
 * client that has to parse one shape on success and another on failure grows a
 * branch that is only exercised when something is already going wrong.
 */

import { Hono } from "hono";

import {
  cancelLogin,
  isCliAuthProvider,
  readLogin,
  startLogin,
  submitCode,
  type CliAuthTarget,
} from "../lib/cli-auth.ts";

const r = new Hono();

/** Max code length accepted. Google's authorization codes run ~73 characters;
 *  this is generous without being an invitation to POST a megabyte. */
const MAX_CODE_BYTES = 2048;

function badProvider(name: string) {
  return {
    error: `unknown provider: ${name}`,
    detail: "Valid providers are: agy, gemini-cli, claude.",
  };
}

r.post("/:provider/start", async (c) => {
  const provider = c.req.param("provider");
  if (!isCliAuthProvider(provider)) return c.json(badProvider(provider), 400);

  let target: CliAuthTarget | null = null;
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    const configDir = typeof body.config_dir === "string" ? body.config_dir.trim() : "";
    if (slug !== "" && configDir !== "") target = { slug, config_dir: configDir };
  } catch {
    target = null;
  }

  const { status, httpStatus } = await startLogin(provider, target);
  return c.json(status, httpStatus as 200);
});

r.get("/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isCliAuthProvider(provider)) return c.json(badProvider(provider), 400);
  return c.json(await readLogin(provider));
});

r.post("/:provider/code", async (c) => {
  const provider = c.req.param("provider");
  if (!isCliAuthProvider(provider)) return c.json(badProvider(provider), 400);

  let code = "";
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    code = typeof body.code === "string" ? body.code.trim() : "";
  } catch {
    // Deliberately does NOT quote the body back: on this endpoint the body IS
    // the credential.
    return c.json({ error: "body must be JSON with a `code` string" }, 400);
  }

  if (code === "") return c.json({ error: "code is required" }, 400);
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return c.json({ error: "code is implausibly long; nothing was submitted" }, 400);
  }

  const { status, httpStatus } = await submitCode(provider, code);
  return c.json(status, httpStatus as 200);
});

r.post("/:provider/cancel", async (c) => {
  const provider = c.req.param("provider");
  if (!isCliAuthProvider(provider)) return c.json(badProvider(provider), 400);
  return c.json(await cancelLogin(provider));
});

export default r;
