/**
 * linkage-scope.cjs — proves the side panel is scoped by the OPEN CHAT, not by
 * a panel-local selector (U9 / v3 rule), and that it costs one request.
 *
 * Opens a chat that resolves to a project, then asserts:
 *   1. exactly ONE `GET /api/chat/:id/linkage` fires in a 25s window
 *      (staleTime: Infinity, no refetchInterval — NFU3: the poll budget does
 *      not grow), and
 *   2. every `GET /api/agents` after that carries `project_id=<linked project>`
 *      — i.e. the panel follows the chat.
 *
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie.txt)" \
 *     RAIL_URL=http://127.0.0.1:7795 node docs/plan/artifacts/phase400/linkage-scope.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("/opt/hermes-workspace/node_modules/playwright");

function resolveChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  const c = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (!c.length) throw new Error(`no chromium under ${cache}`);
  return c[0];
}

const BASE = process.env.RAIL_URL ?? "http://127.0.0.1:7795";
const COOKIE = process.env.FORGE_SESSION_COOKIE ?? "";
/** The synthetic phase-300 fixture chat: linked via metadata.origin_chat_id. */
const LINKED_CHAT = process.env.LINKED_CHAT ?? "c0de0304-0000-4000-8000-000000000304";
const OUT = __dirname;

(async () => {
  if (!COOKIE) throw new Error("FORGE_SESSION_COOKIE is empty");
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: COOKIE,
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  const seen = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/proxy/")) seen.push(u.split("/api/proxy")[1]);
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "networkidle", timeout: 60_000 });
  if (page.url().includes("/signin")) throw new Error("redirected to /signin — cookie stale");
  await page.waitForTimeout(2_000);
  await page.getByText("CHAT", { exact: true }).first().click();
  await page.waitForTimeout(3_000);

  // Open the linked chat by clicking its rail row (found by title text).
  const mark = seen.length;
  await page.getByText("phase300 round-304 linkage fixture", { exact: false }).first().click();
  await page.waitForTimeout(25_000); // > 3 agents polls (4s) and > 2 chat-list polls (8s)

  const after = seen.slice(mark);
  const linkageCalls = after.filter((u) => u.includes(`/chat/${LINKED_CHAT}/linkage`));
  const agentCalls = after.filter((u) => u.startsWith("/agents"));
  const scoped = agentCalls.filter((u) => u.includes("project_id="));
  const projectIds = [...new Set(scoped.map((u) => u.split("project_id=")[1].split("&")[0]))];

  const result = {
    linkage_requests: linkageCalls.length,
    agents_requests: agentCalls.length,
    agents_requests_scoped: scoped.length,
    project_ids_seen: projectIds,
    managers_requests: after.filter((u) => u.includes("managers")).length,
    pass:
      linkageCalls.length === 1 &&
      agentCalls.length > 0 &&
      scoped.length === agentCalls.length &&
      projectIds.length === 1 &&
      after.every((u) => !u.includes("managers")),
  };
  fs.writeFileSync(path.join(OUT, "linkage-scope.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.pass) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
