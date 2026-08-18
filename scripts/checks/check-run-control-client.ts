/**
 * check-run-control-client.ts — the client half of the control plane, asserted
 * without a browser and without an engine (`postRunStop` / `postRunTerminate`
 * in `forge-control-web/app/desktop/team/teamApi.ts`).
 *
 * Round 1350 wires the team panel's two disabled buttons to
 * `POST /api/runs/:id/stop|terminate`.
 *
 * ── What changed under this script, and why it still exists ────────────────
 * The header used to say the path was UNREACHABLE at runtime — all-false
 * capabilities, therefore no browser could prove anything, therefore this
 * script was the only honest proof. That justification died in round 1353:
 * commit 8ec83cc flipped `stop`, `terminate`, `message_into_session` and
 * `resume_finished` to true in `forge-control/src/routes/capabilities.ts`, and
 * the round's reviewer drove both buttons in real Chrome against a scratch run
 * — ⏸ → 202 `{"stopping":true}` with the run confirmed `paused` in psql, and
 * armed ✕ → 202 `{"terminating":true}`. A browser CAN prove it now, and a
 * browser proof should be taken every round the panel changes.
 *
 * The script's VALUE is undiminished, for a reason that never depended on the
 * flag: a browser can only produce the answers the engine chooses to give it.
 * It cannot make the engine reply 404, or 500 with an HTML proxy page, or a
 * 2xx whose body is torn mid-JSON, and it cannot type a "/" into a run id.
 * Those four wire shapes are exactly where a client silently degrades a
 * refusal into a success — so they are stubbed here: hand the client each
 * answer the engine can actually emit and assert what comes back out.
 *
 * Read it as the wire-shape half of the proof. The reachability half is the
 * browser's, and `scripts/checks/check-stop-affordance.tsx` holds the third
 * piece — that the BUTTON's disabled state agrees with what a click does,
 * which is the gap the capability flip opened (round 1353 review, finding 1).
 *
 * The claim under test is NFU6 applied to a mutation: a refusal must NEVER
 * resolve, and the sentence the operator reads in the toast must be the
 * SERVER'S OWN, not "409 Conflict". run-control.ts answers every rejection with
 * `{ error: "<reason>" }` (§3/§4 → `statusVerb`, 404 "unknown run" / 409 from
 * the rules module), so an `error` body that arrives as a resolved promise, or
 * as a generic status line, is a bug this script has to catch.
 *
 * Covered:
 *   • 202 {stopping:true} / {terminating:true}  → resolves with the body
 *   • 409 {"error":"run is already cancelled"}  → REJECTS with exactly that
 *   • 404 {"error":"unknown run"}               → REJECTS with exactly that
 *   • 500 with a non-JSON body (a proxy page)   → rejects, message non-empty
 *   • a run id containing "/" is percent-encoded into ONE path segment
 *
 * vitest is not set up in either repo and NFU8 forbids adding one, so this is a
 * plain tsx script: one PASS/FAIL line per case, `process.exit(1)` if anything
 * fails. Same shape as check-team-confirm.ts, deliberately.
 *
 * Run:
 *   cd forge-control-web && ../forge-control/node_modules/.bin/tsx \
 *     ../scripts/checks/check-run-control-client.ts
 * (tsx lives in forge-control's devDependencies; forge-control-web has none.)
 */

import {
  postRunStop,
  postRunTerminate,
} from "../../forge-control-web/app/desktop/team/teamApi.ts";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        expected ${String(expected)}, got ${String(actual)}`),
  );
}

/** The URL the last stubbed fetch was called with, and the method it used. */
let lastUrl = "";
let lastMethod = "";

/** Answer every request with one canned response. `body` is sent verbatim, so a
 *  non-JSON string is genuinely non-JSON on the wire. */
function stubFetch(status: number, statusText: string, body: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    lastUrl = String(input);
    lastMethod = init?.method ?? "GET";
    return new Response(body, { status, statusText });
  }) as typeof fetch;
}

/** Resolve to the Error message, or a marker if the promise resolved instead —
 *  "it did not throw" must read as a FAILURE, never as a pass. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    const v = await p;
    return `<RESOLVED: ${JSON.stringify(v)}>`;
  } catch (e) {
    return e instanceof Error ? e.message : `<non-Error: ${String(e)}>`;
  }
}

const RUN = "3f2b1c4d-0000-4000-8000-aaaabbbbcccc";

/** Every case awaits, and forge-control-web is not an ESM package — tsx
 *  transforms this file to CJS, where top-level await is a transform error. So
 *  one `main()`, unlike the synchronous check scripts next to it. */
async function main(): Promise<void> {
  console.log("── 202: the accepted verb ───────────────────────────────────");
  {
    stubFetch(202, "Accepted", JSON.stringify({ stopping: true }));
    check("stop resolves with the engine's body", (await postRunStop(RUN)).stopping, true);
    check("…as a POST", lastMethod, "POST");
    check("…to /api/proxy/runs/:id/stop", lastUrl, `/api/proxy/runs/${RUN}/stop`);

    stubFetch(202, "Accepted", JSON.stringify({ terminating: true }));
    check(
      "terminate resolves with the engine's body",
      (await postRunTerminate(RUN)).terminating,
      true,
    );
    check("…to /api/proxy/runs/:id/terminate", lastUrl, `/api/proxy/runs/${RUN}/terminate`);
  }

  console.log("\n── 409: the reason reaches the toast VERBATIM ───────────────");
  {
    stubFetch(409, "Conflict", JSON.stringify({ error: "run is already cancelled" }));
    check(
      "stop rejects with the server's sentence, not '409 Conflict'",
      await rejection(postRunStop(RUN)),
      "run is already cancelled",
    );
    check(
      "terminate rejects the same way",
      await rejection(postRunTerminate(RUN)),
      "run is already cancelled",
    );
    // The race answer of run-control.ts's `raceReason` — long, punctuated, and
    // the only text that explains what to do next. It must survive whole.
    const race =
      "run moved to 'completed' while the stop was being applied - re-read the run and retry";
    stubFetch(409, "Conflict", JSON.stringify({ error: race }));
    check("…including the race reason, unabridged", await rejection(postRunStop(RUN)), race);
  }

  console.log("\n── 404 ──────────────────────────────────────────────────────");
  {
    stubFetch(404, "Not Found", JSON.stringify({ error: "unknown run" }));
    check("stop on an unknown run rejects", await rejection(postRunStop(RUN)), "unknown run");
    check(
      "terminate on an unknown run rejects",
      await rejection(postRunTerminate(RUN)),
      "unknown run",
    );
  }

  console.log("\n── 500 with a body that is not JSON ─────────────────────────");
  {
    stubFetch(500, "Internal Server Error", "<html><body>502 Bad Gateway</body></html>");
    const msg = await rejection(postRunStop(RUN));
    check("it rejects (never resolves)", msg.startsWith("<RESOLVED"), false);
    check("…with a non-empty message", msg.trim().length > 0, true);
    check("…that names the status", msg.includes("500"), true);
    // A 200 with a torn body is the same failure wearing a success code.
    stubFetch(200, "OK", "not json at all");
    const ok = await rejection(postRunTerminate(RUN));
    check("a 2xx with a non-JSON body rejects too", ok.startsWith("<RESOLVED"), false);
  }

  console.log("\n── a run id with a slash cannot escape its path segment ─────");
  {
    stubFetch(202, "Accepted", JSON.stringify({ stopping: true }));
    await postRunStop("evil/../capabilities").catch(() => undefined);
    check(
      "the id is percent-encoded",
      lastUrl,
      "/api/proxy/runs/evil%2F..%2Fcapabilities/stop",
    );
    // "" / api / proxy / runs / <id> / stop — six pieces, and the id is one.
    check("…so no raw slash reaches the path", lastUrl.split("/").length, 6);
  }

  console.log(
    `\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — run-control client`,
  );
}

main().then(
  () => process.exit(failures === 0 ? 0 : 1),
  (e: unknown) => {
    // A throw here is the harness failing, not an assertion failing. Say which.
    console.error("HARNESS ERROR —", e);
    process.exit(1);
  },
);
