/**
 * check-integrations.tsx — round 1350's unit check for the Integrations panel
 * and the router behind it.
 *
 * The brief for this round is mostly a list of things that must NOT be built
 * (no Ultra OAuth button, no invented Gemini quota bar, no cloud-platform
 * scope) and one thing that must never happen (the API key leaking into a
 * response, a log line, or the database). Both halves are assertable, so they
 * are asserted here rather than left to a reviewer's reading.
 *
 *   §1 THE KEY IS WRITE-ONLY. Store it, then prove it appears in no response
 *      body from any of the four endpoints — including the failure bodies,
 *      including an upstream body that echoes it back.
 *   §2 THE TWO DOCUMENTED FAILURES ARE TRANSLATED. The verbatim 403 bodies
 *      captured in the round-1302 research (§1.2 of
 *      docs/plan/operator-visibility/artifacts/phase1700/gemini-ultra-oauth.md)
 *      classify into plain-English verdicts, not "HTTP 403".
 *   §3 UNKNOWN IS NOT ZERO. When the spend log cannot be reached, the usage
 *      endpoint answers 503 with a diagnostic — never a zeroed rollup.
 *   §4 THE GOOGLE CREDENTIAL IS READ, NEVER RELAYED. Scopes and timestamps
 *      come out; the refresh token and client secret never do, not even
 *      inside an upstream error body.
 *   §5 THE PANEL RENDERS IN BOTH THEMES AND MAKES NO INVENTED CLAIMS.
 *
 * Upstream calls are stubbed at `globalThis.fetch`, so this check is offline
 * and deterministic. The secret store and the Google credential are pointed
 * at a temp directory via SECRET_STORE_DIR / GOOGLE_TOKEN_PATH before the
 * router is imported — nothing here touches the real store.
 *
 * Run (from forge-control-web, whose node_modules holds react/react-dom):
 *   ../forge-control/node_modules/.bin/tsx --tsconfig ../tsconfig.checks.json \
 *     ../scripts/checks/check-integrations.tsx
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

let failures = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ── Isolation: temp store + temp credential, set BEFORE the import ──────── */

const sandbox = mkdtempSync(join(tmpdir(), "check-integrations-"));
const storeDir = join(sandbox, "store");
const tokenPath = join(sandbox, "google_token.json");
process.env.SECRET_STORE_DIR = storeDir;
process.env.GOOGLE_TOKEN_PATH = tokenPath;
// Added in phase 4/B4b, and NOT optional. POST /google/test now PERSISTS its
// verdict (R48) to `FORGE_CONNECTION_STATUS_DIR`, default
// /opt/ai-os/.secrets/status. Every upstream call in this file is stubbed, so
// without this line a run of this check would write a FABRICATED
// {"ok":true,…} record into the production store, and live forge-control would
// then read it back and render Google as CONNECTED on the strength of a test
// double. That is the exact lie phase 4 exists to delete, arriving through the
// check that is supposed to catch it.
process.env.FORGE_CONNECTION_STATUS_DIR = join(sandbox, "status");
delete process.env.DATABASE_URL; // §3 wants the "cannot tell" branch

const FAKE_REFRESH = "1//fake-refresh-token-value-0000";
const FAKE_CLIENT_SECRET = "GOCSPX-fake-client-secret-0000";
writeFileSync(
  tokenPath,
  JSON.stringify({
    token: "ya29.fake-access",
    refresh_token: FAKE_REFRESH,
    client_id: "1234-fake.apps.googleusercontent.com",
    client_secret: FAKE_CLIENT_SECRET,
    token_uri: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
    ],
    expiry: "2026-08-04T15:52:07.536679Z",
    account: "",
    universe_domain: "googleapis.com",
    type: "authorized_user",
  }),
);

const KEY = "AIzaSyCHECK1350exampleKEYvalue0000000000";

/* ── Upstream stub ───────────────────────────────────────────────────────── */

type Stub = { status: number; body: string } | { throws: Error };
let nextModels: Stub = { status: 200, body: JSON.stringify({ models: [] }) };
let nextToken: Stub = { status: 200, body: JSON.stringify({ access_token: "at" }) };
let nextProfile: Stub = {
  status: 200,
  body: JSON.stringify({ emailAddress: "konrad.schrein@gmail.com" }),
};
/** Every upstream request this check saw, so §1 can assert the key travelled
 *  as a header and never as a query parameter. */
const seen: Array<{ url: string; headers: Record<string, string> }> = [];

function respond(stub: Stub): Promise<Response> {
  if ("throws" in stub) return Promise.reject(stub.throws);
  return Promise.resolve(
    new Response(stub.body, {
      status: stub.status,
      headers: { "content-type": "application/json" },
    }),
  );
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    headers[k] = v;
  });
  seen.push({ url, headers });
  if (url.includes("generativelanguage.googleapis.com")) return respond(nextModels);
  if (url.includes("oauth2.googleapis.com/token")) return respond(nextToken);
  if (url.includes("gmail.googleapis.com")) return respond(nextProfile);
  return Promise.reject(new Error(`unstubbed upstream: ${url}`));
}) as typeof fetch;

async function main(): Promise<void> {
  /* ── The subjects ────────────────────────────────────────────────────────── */

  const { default: router } = await import(
    "../../forge-control/src/routes/integrations.ts"
  );
  /* Round 1876 deleted the `IntegrationsPanel` wrapper: the CONNECTIONS
   * surface mounts each card under its own row, so the cards themselves are
   * what this check renders. Rendering them side by side is exactly what the
   * wrapper did. */
  const { GeminiCard, GoogleCard } = await import(
    "../../forge-control-web/app/desktop/settings/integrationCards.tsx"
  );

  interface Answer {
    status: number;
    text: string;
    json: Record<string, unknown>;
  }

  async function req(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Answer> {
    const res = await router.request(path, {
      method: init?.method ?? "GET",
      ...(init?.body === undefined
        ? {}
        : {
            body: JSON.stringify(init.body),
            headers: { "content-type": "application/json" },
          }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return { status: res.status, text, json };
  }

  /* Every response body this check has seen, checked for the key at the end. */
  const bodies: Array<[string, string]> = [];
  async function call(
    label: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Answer> {
    const a = await req(path, init);
    bodies.push([label, a.text]);
    return a;
  }

  /* ── §1 the key is write-only ────────────────────────────────────────────── */

  console.log("§1 the key is write-only");

  const empty = await call("gemini:empty", "/gemini");
  ok("empty store reports present:false", (empty.json.key as { present: boolean }).present === false);

  const noKeyTest = await call("gemini:test-no-key", "/gemini/test", { method: "POST" });
  ok("test without a key is a 400, not a fake verdict", noKeyTest.status === 400);
  ok("…and names the reason", noKeyTest.json.reason === "no_key_stored");

  const rejected = await call("gemini:bad-shape", "/gemini/key", {
    method: "POST",
    body: { key: "has spaces and 'quotes'" },
  });
  ok("a malformed key is refused", rejected.status === 400);
  ok(
    "…and the refusal does not echo what was pasted",
    !rejected.text.includes("has spaces"),
  );

  const stored = await call("gemini:store", "/gemini/key", {
    method: "POST",
    body: { key: KEY },
  });
  ok("storing a key answers 201", stored.status === 201);
  const storedKey = stored.json.key as { masked: string; present: boolean };
  ok("…reports present", storedKey.present === true);
  ok(
    "…and masks to the last four characters only",
    storedKey.masked === `…${KEY.slice(-4)}`,
    storedKey.masked,
  );

  nextModels = {
    status: 200,
    body: JSON.stringify({
      models: [
        {
          name: "models/gemini-3.7-flash",
          displayName: "Gemini 3.7 Flash",
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
        },
        { name: "models/gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview" },
      ],
      nextPageToken: "",
    }),
  };
  const good = await call("gemini:test-ok", "/gemini/test", { method: "POST" });
  ok("a reachable key reports ok", good.json.ok === true);
  ok("…with the model count", good.json.count === 2);
  ok(
    "…ids carry no models/ prefix",
    (good.json.models as Array<{ id: string }>)[0].id === "gemini-3.7-flash",
  );
  ok("…and is not flagged truncated", good.json.truncated === false);

  const modelCall = seen.filter((s) => s.url.includes("generativelanguage")).at(-1);
  ok("the key travels as x-goog-api-key", modelCall?.headers["x-goog-api-key"] === KEY);
  ok(
    "…and never in the URL, where a log would keep it",
    modelCall !== undefined && !modelCall.url.includes(KEY),
    modelCall?.url,
  );

  /* The nastiest case: an upstream body that quotes the key back at us. */
  nextModels = {
    status: 400,
    body: JSON.stringify({
      error: { code: 400, message: `API key not valid: ${KEY}`, status: "INVALID_ARGUMENT" },
    }),
  };
  const echoed = await call("gemini:test-echoed", "/gemini/test", { method: "POST" });
  ok("an upstream echo of the key is scrubbed", !echoed.text.includes(KEY));
  ok("…and replaced with a marker", echoed.text.includes("<redacted>"));

  /* ── §2 the two documented failures are translated ───────────────────────── */

  console.log("§2 the documented failures become sentences");

  nextModels = {
    status: 403,
    body: JSON.stringify({
      error: {
        code: 403,
        message:
          "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
        status: "PERMISSION_DENIED",
      },
    }),
  };
  const unregistered = await call("gemini:unregistered", "/gemini/test", { method: "POST" });
  ok("no-identity 403 → not_an_api_key", unregistered.json.reason === "not_an_api_key");
  ok(
    "…with a message a human can act on",
    String(unregistered.json.message).includes("AI Studio"),
  );

  nextModels = {
    status: 403,
    body: JSON.stringify({
      error: {
        code: 403,
        message: "Request had insufficient authentication scopes.",
        status: "PERMISSION_DENIED",
        details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
      },
    }),
  };
  const scoped = await call("gemini:scope-short", "/gemini/test", { method: "POST" });
  ok("scope-short 403 → oauth_token_not_key", scoped.json.reason === "oauth_token_not_key");
  ok(
    "…and says why the Google account cannot be used instead",
    String(scoped.json.message).includes("AI Ultra"),
  );

  nextModels = { throws: Object.assign(new Error("aborted"), { name: "TimeoutError" }) };
  const timedOut = await call("gemini:timeout", "/gemini/test", { method: "POST" });
  ok("a timeout is reported as untested, not invalid", timedOut.json.reason === "timeout");
  ok(
    "…and says so in words",
    String(timedOut.json.message).includes("says nothing about whether it is valid"),
  );

  const deleted = await call("gemini:delete", "/gemini/key", { method: "DELETE" });
  ok("delete removes the key", deleted.json.deleted === true);
  const afterDelete = await call("gemini:after-delete", "/gemini");
  ok(
    "…and the store reports it gone",
    (afterDelete.json.key as { present: boolean }).present === false,
  );
  const deleteAgain = await call("gemini:delete-again", "/gemini/key", { method: "DELETE" });
  ok("deleting nothing is a 404, not a silent ok", deleteAgain.status === 404);

  /* ── §3 unknown is not zero ──────────────────────────────────────────────── */

  console.log("§3 unreachable usage is unknown, not zero");
  const usage = await call("gemini:usage", "/gemini/usage");
  ok("no DSN → 503", usage.status === 503);
  ok(
    "…and the body says unknown rather than reporting a total",
    String(usage.json.error).includes("unknown, not zero"),
  );
  ok("…and carries a diagnostic", typeof usage.json.detail === "string");
  ok("…and no rollup is invented", usage.json.totals === undefined);

  /* ── §4 the Google credential is read, never relayed ─────────────────────── */

  console.log("§4 the Google credential is read, never relayed");
  const google = await call("google:get", "/google");
  const account = (google.json.accounts as Array<Record<string, unknown>>)[0];
  ok("the credential is found", account !== undefined);
  ok("scopes are listed", (account.scopes as string[]).length === 3);
  ok("the refresh token is reported as present, not returned", account.has_refresh_token === true);
  ok("the email is null until a live check answers", account.email === null);
  ok(
    "re-auth is offered as a command",
    String((google.json.reauth as { command: string }).command).includes("setup.py"),
  );
  ok(
    "…and marked interactive",
    (google.json.reauth as { interactive: boolean }).interactive === true,
  );

  nextToken = {
    status: 400,
    body: JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
  };
  const revoked = await call("google:invalid-grant", "/google/test", { method: "POST" });
  ok("a revoked consent is named invalid_grant", revoked.json.reason === "invalid_grant");
  ok("…and never claims to be ok", revoked.json.ok === false);
  ok(
    "…and hands over the re-auth command",
    String(revoked.json.reauth_command).includes("setup.py"),
  );

  nextToken = { status: 200, body: JSON.stringify({ access_token: "ya29.fresh" }) };
  const alive = await call("google:ok", "/google/test", { method: "POST" });
  ok("a live consent reports ok", alive.json.ok === true);
  ok("…and yields the address of record", alive.json.email === "konrad.schrein@gmail.com");
  const backfilled = await call("google:get-after", "/google");
  ok(
    "…which the account view then shows",
    ((backfilled.json.accounts as Array<Record<string, unknown>>)[0].email as string) ===
      "konrad.schrein@gmail.com",
  );

  /* The whole-run leak sweep: no response body, anywhere, carried a credential. */
  console.log("§4b nothing leaked across every response in this run");
  for (const [label, text] of bodies) {
    ok(`${label}: no API key`, !text.includes(KEY));
    ok(`${label}: no refresh token`, !text.includes(FAKE_REFRESH));
    ok(`${label}: no client secret`, !text.includes(FAKE_CLIENT_SECRET));
  }

  /* ── §5 the panel ────────────────────────────────────────────────────────── */

  console.log("§5 the panel: tokens only, no invented claims");
  const markup =
    renderToStaticMarkup(<GeminiCard />) + renderToStaticMarkup(<GoogleCard />);
  ok(
    "both cards mark themselves",
    markup.includes("data-gemini-card") && markup.includes("data-google-card"),
  );
  ok("body only — no viewport claim", !/100dvh|100vh/.test(markup));
  ok("body only — no links out of the shell", !/<a /.test(markup));

  const HEX = /#[0-9a-fA-F]{3,8}\b/;
  const FUNC_COLOUR = /\b(?:rgba?|hsla?|oklch|color-mix)\(/;
  ok("no hex literal", !HEX.test(markup), HEX.exec(markup)?.[0]);
  ok("no rgb()/hsl()/oklch()", !FUNC_COLOUR.test(markup), FUNC_COLOUR.exec(markup)?.[0]);

  ok("the key field is a password field", markup.includes('type="password"'));
  ok(
    "…rendered empty — a stored key is never put back into the DOM",
    !/type="password"[^>]*value="[^"]+"/.test(markup),
  );

  /* The round-1302 prohibitions, as assertions rather than good intentions. */
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL(
        "../../forge-control-web/app/desktop/settings/integrationCards.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  /* Comments are stripped first. The file's header explains at length WHY
   * there is no Ultra button and no cloud-platform scope; a prohibition check
   * that fired on the prose documenting the prohibition would be noise. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  ok("no Connect-Google-AI-Ultra affordance", !/connect[^\n]{0,20}ultra/i.test(code));
  ok("no invented model id", !code.includes("4.7"));
  ok("no cloud-platform scope request", !/auth\/cloud-platform/.test(code));
  ok(
    "no percentage bar for Gemini",
    !/width:\s*`?\$\{[^}]*(pct|percent|utilization)/i.test(code),
  );
  ok("the pool is named as the default path", source.includes("Gemini Pool stays the default"));

  rmSync(sandbox, { recursive: true, force: true });
}

void main().then(
  () => {
    console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err: unknown) => {
    // A throw here is a check failure, not a silent pass: print it loudly.
    console.error("check-integrations crashed:", err);
    process.exit(1);
  },
);
