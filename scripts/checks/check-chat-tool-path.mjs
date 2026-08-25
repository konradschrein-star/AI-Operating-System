#!/usr/bin/env node
/**
 * Regression test: THE PATH IN A TOOL BLOCK OPENS — in a real browser.
 *
 * WHY A SECOND BROWSER CHECK. `check-chat-reference-navigation.mjs` drives the
 * inline `code` pills in an agent's PROSE. This one drives the tool rows, which
 * are a different renderer entirely (`AssistantThread.ToolCallRow`, not
 * `MessageMarkdown`) and are where paths are densest — a worker transcript is
 * mostly `Read {"file_path":"/opt/…"}`. Round 1's own verification screenshots
 * ("r1-aios-abs-pill-missing") were read as a detector bug and were nothing of
 * the kind: the paths on screen were inside tool blocks, which never reach the
 * markdown renderer at all. The two checks share a stack and assert different
 * surfaces; keep them separate.
 *
 * BOTH RENDER MODES, because they are different code paths and only one of them
 * is what Konrad reads:
 *   · raw     — the manager chat and ProjectsSurface. Tool name + a 110-char
 *               slice of the payload. Only the sub-range that IS the path
 *               becomes a click target, and this check asserts the surrounding
 *               text did not move by a character.
 *   · summary — AgentChatView's drilled worker view. The derived one-liner
 *               (`read …/Profile/Operating Manual.md`), whole gist clickable.
 * The drilled view is reached by seeding `forge.chat.navStack`, which is how
 * ChatSurface restores a drill-in across F5 (stored-nav.ts).
 *
 * WHAT IS ASSERTED, and why each one can fail:
 *   1. WHICH rows offer a click. A path inside a root does; a Bash command, a
 *      path outside every root, and a FAILED call do not. An affordance that
 *      usually fails is worse than none (code-path-link.ts).
 *   2. The raw payload slice is byte-identical to what it rendered before.
 *   3. Clicking one FROM THE TEAM TAB opens the file: the panel flips to Files,
 *      the file's own text appears, no new browser tab, and the row does NOT
 *      also expand (the click must not fall through to the row's toggle).
 *   4. The same click works in summary mode.
 *   5. Ctrl-click goes to /document instead, in a new tab.
 *
 * ZERO LIVE WRITES BY CONSTRUCTION: the fixture chat is seeded into a scratch
 * database, and the check refuses `content_forge` unless ALLOW_LIVE_SEED=1.
 * Everything else (files, roots, search) is proxied read-only to the real API.
 *
 * INPUTS (environment)
 *   BASE_URL           the console under test        (default http://127.0.0.1:7921)
 *   FORGE_API_URL      the forge-control it talks to (default http://127.0.0.1:7920)
 *   SEED_DATABASE_URL  the database FORGE_API_URL's chat router reads (required)
 *   AUTH_SECRET        to mint a session cookie   (or FORGE_SESSION_COOKIE)
 *   COOKIE_NAME        session cookie name (default __Secure-authjs.session-token)
 *   OUT_DIR            screenshots (default /opt/ai-os/uploads/$FORGE_RUN_ID)
 *   ALLOW_LIVE_SEED=1  permit seeding into content_forge (deploy task only)
 *   HEADFUL=1          watch it run
 *
 * The stack recipe (scratch db → probe forge-control → production console) is
 * docs/plan/artifacts/chat-ref-nav/README.md. Use a PRODUCTION build: under
 * `next dev`, `reactStrictMode` double-mounts FileExplorerPanel and its second
 * `loadDir` wins the race against the open request.
 *
 * EXIT: 0 iff every named assertion passed; 1 on any FAIL; 2 on a harness fault
 * (dependency missing, not signed in, fixture not served) — a harness fault is
 * NOT a green run and is never swallowed.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/* ── Inputs ─────────────────────────────────────────────────────────────── */

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:7921").replace(/\/+$/, "");
const FORGE_API_URL = (process.env.FORGE_API_URL ?? "http://127.0.0.1:7920").replace(/\/+$/, "");
const SEED_DATABASE_URL = process.env.SEED_DATABASE_URL ?? "";
const COOKIE_NAME = process.env.COOKIE_NAME ?? "__Secure-authjs.session-token";
const OUT_DIR =
  process.env.OUT_DIR ??
  (process.env.FORGE_RUN_ID
    ? `/opt/ai-os/uploads/${process.env.FORGE_RUN_ID}`
    : path.join(process.cwd(), "chat-tool-path-shots"));

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

/** The test could not be run — which is not the same as a failing assertion
 *  and must never be reported as one. */
class HarnessError extends Error {}

/* ── Dependencies, borrowed by explicit path ──────────────────────────────
 * playwright, pg and @auth/core are not dependencies of this repo and must not
 * become ones. Every miss throws naming the path it looked at. */

function requireFile(p, what, hint) {
  if (!existsSync(p)) throw new HarnessError(`${what} not found at ${p}\n  ${hint}`);
  return p;
}

function playwrightEntry() {
  return requireFile(
    process.env.PLAYWRIGHT_MODULE ?? "/opt/hermes-workspace/node_modules/playwright/index.mjs",
    "playwright",
    "set PLAYWRIGHT_MODULE to a playwright index.mjs. Do NOT add playwright to this repo.",
  );
}

/** The installed chromium revision is not the one playwright asks for, and
 *  `chromium.launch()` with no executablePath then demands
 *  `npx playwright install` — which must NOT be run. Scan instead. */
function chromeExecutable() {
  if (process.env.CHROME_PATH) {
    return requireFile(process.env.CHROME_PATH, "CHROME_PATH", "point it at a chrome binary");
  }
  const cache = "/root/.cache/ms-playwright";
  if (!existsSync(cache)) throw new HarnessError(`no playwright browser cache at ${cache}`);
  const candidates = readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .flatMap((d) => [
      path.join(cache, d, "chrome-linux64", "chrome"),
      path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    ]);
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) {
    throw new HarnessError(
      `no chrome binary under ${cache}\n  looked at:\n    ${candidates.join("\n    ")}\n` +
        "  do NOT run `npx playwright install`; set CHROME_PATH instead",
    );
  }
  return hit;
}

/** @auth/core is not resolvable by bare specifier under pnpm — find the real
 *  file inside the console's own store so the encoder matches the decoder. */
function authJwtModule() {
  const store = path.join(REPO_ROOT, "forge-control-web", "node_modules", ".pnpm");
  if (!existsSync(store)) {
    throw new HarnessError(
      `pnpm store missing at ${store}\n  run: cd forge-control-web && pnpm install --frozen-lockfile --prod=false`,
    );
  }
  const dir = readdirSync(store).find((d) => d.startsWith("@auth+core@"));
  if (!dir) throw new HarnessError(`no @auth+core@* package under ${store}`);
  return requireFile(
    path.join(store, dir, "node_modules", "@auth", "core", "jwt.js"),
    "@auth/core jwt.js",
    "the console's next-auth version moved; update this path",
  );
}

function pgModule() {
  return requireFile(
    path.join(REPO_ROOT, "forge-control", "node_modules", "pg", "lib", "index.js"),
    "pg",
    "run: cd forge-control && pnpm install --frozen-lockfile --prod=false",
  );
}

/* ── The fixture ────────────────────────────────────────────────────────────
 *
 * One tool call per branch of the affordance rule. `openable` is what the row
 * must offer; getting one wrong is a named FAIL, not a missing element.
 *
 * The two target files are chosen for STABILITY, not convenience: a vault note
 * and a file in the forge-control source tree, both of which outlive any
 * worktree. `marker` is text that lives in the file and NOWHERE in this
 * fixture, so "is it on screen" is a discriminating question. */

const VAULT_FILE = "/opt/obsidian-vault/Mentor/Profile/Operating Manual.md";
const VAULT_MARKER = "How to Work With Konrad";
const SRC_FILE = "/opt/forge-ai-os/forge-control-web/app/desktop/chat/tool-summary.ts";
const WORKSPACE_FILE = "/opt/ai-os/workspace/OVERNIGHT.md";
/** Outside every configured root: a path under no root's directory at all. It
 *  must render as plain text, never as a click.
 *
 *  THIS FIXTURE WENT STALE AND THE CHECK WENT RED FOR IT. It used to name
 *  `/root/.claude/projects/-opt-forge-ai-os/memory/MEMORY.md` — the fleet
 *  knowledge base, "outside every root AND behind resolveInRoot's dot-segment
 *  guard". D6 then made that directory a real read-only root (`ROOTS.memory` in
 *  forge-control/src/routes/files.ts), so the assertion was asserting the
 *  opposite of the product's intent and failed correctly. `/opt/nowhere/` is
 *  chosen because it is not a root, is not INSIDE a root, and — unlike a
 *  dot-segment path — nothing about it depends on a guard that could later be
 *  relaxed. If a root is ever added over it, this constant is the thing to
 *  change, not the assertion. */
const UNREACHABLE_FILE = "/opt/nowhere/not-a-root/notes.md";

const CALLS = [
  {
    id: "read-vault",
    tool: "Read",
    args: { file_path: VAULT_FILE },
    result: "1\t(fixture result body, deliberately not the file's text)\n2\tsecond line",
    openable: true,
    why: "absolute path inside the vault root",
  },
  {
    id: "edit-src",
    tool: "Edit",
    args: { file_path: SRC_FILE, old_string: "aaa", new_string: "bbb" },
    result: "The file has been updated.",
    openable: true,
    why: "absolute path inside the forge-src root",
  },
  {
    id: "bash-with-path",
    tool: "Bash",
    args: { command: `grep -n summarizeTool ${SRC_FILE} | head -3` },
    result: "579:export function summarizeTool(",
    openable: false,
    why: "a shell command is prose — paths are NOT extracted from one",
  },
  {
    id: "read-unreachable",
    tool: "Read",
    args: { file_path: UNREACHABLE_FILE },
    result: "1\t- [some note](x.md)",
    openable: false,
    why: "outside every file root — the API would refuse it, so no click is offered",
  },
  {
    id: "read-failed",
    tool: "Read",
    args: { file_path: "/opt/obsidian-vault/Mentor/Profile/No Such Note.md" },
    result: "<tool_use_error>File does not exist.</tool_use_error>",
    isError: true,
    openable: false,
    why: "a failed call usually failed BECAUSE the file is not there",
  },
  {
    id: "write-pending",
    tool: "Write",
    args: { file_path: WORKSPACE_FILE, content: "x".repeat(40) },
    result: null, // still running
    openable: true,
    why: "a running call still names the file it was asked to write",
  },
];

/** What the raw row renders for a call — the pre-existing derivation, repeated
 *  here so a change to it fails this check instead of passing unnoticed. */
const rawPreview = (call) => JSON.stringify(call.args).replace(/\s+/g, " ").slice(0, 110);

/* ── Assertion ledger ───────────────────────────────────────────────────── */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/* ── Seeding ────────────────────────────────────────────────────────────── */

/** The wire shape is copied from a real capture
 *  (docs/plan/artifacts/phase600/fixtures/run-3853c154-chat.json): a tool_call
 *  is `role:"tool"`, `kind:"tool_call"`, `meta.input` a JSON **string**, and its
 *  outcome is a separate `tool_result` entry joined by `meta.tool_use_id`. An
 *  invented field here would make the whole run a fiction. */
function fixtureThread(now) {
  const thread = [
    { role: "user", content: "Show me the tool-block fixture.", ts: now, kind: "text" },
    {
      role: "assistant",
      content:
        "Here are the tool calls. Every path below lives in a tool block, not in prose — " +
        "which is the surface this check exists for.",
      ts: now,
      kind: "text",
    },
  ];
  for (const call of CALLS) {
    const input = JSON.stringify(call.args);
    const toolUseId = `toolu_fixture_${call.id}`;
    thread.push({
      role: "tool",
      kind: "tool_call",
      ts: now,
      meta: { tool: call.tool, input, tool_use_id: toolUseId },
      content: `${call.tool} ${input}`,
    });
    if (call.result !== null) {
      thread.push({
        role: "tool",
        kind: "tool_result",
        ts: now,
        meta: { is_error: call.isError === true, tool_use_id: toolUseId },
        content: call.result,
      });
    }
  }
  return thread;
}

async function seedRun(pool) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO runs (id, title, prompt, worker, status, thread, budget_usd, spent_usd, metadata,
                       created_at, updated_at, started_at, completed_at)
     VALUES ($1::uuid, $2, $3, 'probe', 'completed', $4::jsonb, 0, 0, $5::jsonb,
             now(), now(), now(), now())`,
    [
      id,
      "chat tool-block path fixture",
      "Show me the tool-block fixture.",
      JSON.stringify(fixtureThread(now)),
      JSON.stringify({ probe: true, check: "check-chat-tool-path" }),
    ],
  );
  return id;
}

/** The seeded row and the API the browser reads MUST be the same database.
 *  Otherwise every assertion fails for a reason unrelated to the feature. */
async function assertApiServesSeed(runId) {
  const url = `${FORGE_API_URL}/api/chat/${runId}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new HarnessError(
      `${url} → HTTP ${res.status}. The run was seeded into SEED_DATABASE_URL but ` +
        "FORGE_API_URL does not serve it — the two are different databases.",
    );
  }
  const thread = (await res.json())?.run?.thread;
  const calls = Array.isArray(thread)
    ? thread.filter((e) => e.kind === "tool_call").length
    : 0;
  if (calls !== CALLS.length) {
    throw new HarnessError(
      `${url} served ${calls} tool calls, expected ${CALLS.length} — the fixture did not survive the round trip`,
    );
  }
}

/* ── Browser helpers ────────────────────────────────────────────────────── */

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

function shooter(page) {
  return async (label) => {
    const file = path.join(OUT_DIR, `${stamp()}-${label}.png`);
    await page.screenshot({ path: file });
    console.log(`    shot ${file}`);
    return file;
  };
}

/** Every tool row on screen: its text, and the click target inside it if any.
 *  `data-openable-source="tool"` is what separates a tool row's target from an
 *  inline pill's — both carry `data-openable-path`. */
async function toolRows(page) {
  return page.$$eval("[data-tool-row]", (els) =>
    els.map((e) => {
      const target = e.querySelector('[data-openable-path][data-openable-source="tool"]');
      return {
        mode: e.getAttribute("data-tool-row"),
        text: (e.textContent ?? "").replace(/\s+/g, " ").trim(),
        openable: target !== null,
        targetText: target === null ? null : (target.textContent ?? ""),
        title: target === null ? null : (target.getAttribute("title") ?? ""),
        expanded: e.querySelector("pre") !== null,
      };
    }),
  );
}

/**
 * The row rendering `call`, found by a substring only it contains.
 *
 * The two modes render the SAME call completely differently — raw shows the
 * JSON payload slice, summary shows `read …/Profile/Operating Manual.md` — so
 * the needle must be something BOTH keep: the last two path segments, which is
 * exactly what `shortPath` preserves. Matching the raw payload alone is how the
 * first run of this check found no rows at all in summary mode.
 */
function rowNeedle(call) {
  const p = call.args.file_path;
  if (typeof p === "string") return p.split("/").slice(-2).join("/");
  return rawPreview(call).slice(0, 40);
}

async function rowFor(page, call) {
  const needle = rowNeedle(call);
  const rows = await toolRows(page);
  const idx = rows.findIndex((r) => r.text.includes(needle));
  if (idx === -1) {
    throw new HarnessError(
      `no tool row for ${call.id}. Rows present:\n    ` +
        rows.map((r) => `${r.openable ? "[openable] " : "           "}${r.text.slice(0, 120)}`).join("\n    "),
    );
  }
  return { idx, ...rows[idx] };
}

async function panelState(page) {
  return page.evaluate(() => ({
    tab: localStorage.getItem("forge.layout.chat.panelTab"),
    breadcrumbs: document.querySelector(".vfl-breadcrumbs")?.textContent?.trim() ?? null,
    selectedRows: Array.from(document.querySelectorAll(".vfl-row--selected")).map((r) =>
      (r.textContent ?? "").trim(),
    ),
    bodyText: document.body.innerText,
  }));
}

/** Poll rather than sleep: a fixed wait either misses the transition or wastes
 *  the run. Returns false on timeout; the caller decides if that is a FAIL. */
async function waitFor(page, fn, { timeoutMs = 15000, stepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(stepMs);
  }
}

/* ── Main ───────────────────────────────────────────────────────────────── */

async function main() {
  if (!SEED_DATABASE_URL) {
    throw new HarnessError(
      "SEED_DATABASE_URL is required — the database whose chat router FORGE_API_URL serves.\n" +
        "  See docs/plan/artifacts/chat-ref-nav/README.md for the scratch-database recipe.",
    );
  }
  const dbName = SEED_DATABASE_URL.split("/").pop()?.split("?")[0] ?? "";
  if (dbName === "content_forge" && process.env.ALLOW_LIVE_SEED !== "1") {
    throw new HarnessError(
      "refusing to seed a fixture chat into the LIVE database (content_forge).\n" +
        "  Use a scratch database, or set ALLOW_LIVE_SEED=1 if you are the deploy task.",
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const { chromium } = await import(playwrightEntry());
  const { default: pg } = await import(pgModule());
  const executablePath = chromeExecutable();

  let cookieValue = process.env.FORGE_SESSION_COOKIE ?? "";
  if (!cookieValue) {
    if (!process.env.AUTH_SECRET) {
      throw new HarnessError(
        "neither FORGE_SESSION_COOKIE nor AUTH_SECRET is set — cannot reach an authenticated console.\n" +
          "  AUTH_SECRET lives in forge-control-web/.env.local.",
      );
    }
    const { encode } = await import(authJwtModule());
    // The salt MUST equal the cookie name: in next-auth v5 it is part of the key
    // derivation, and a mismatch fails auth SILENTLY — the middleware 307s to
    // /signin, which answers HTTP 200 and reads as a clean run.
    cookieValue = await encode({
      token: { name: "chat tool-path check", email: "probe@local", sub: "probe" },
      secret: process.env.AUTH_SECRET,
      salt: COOKIE_NAME,
      maxAge: 3600,
    });
  }

  const pool = new pg.Pool({ connectionString: SEED_DATABASE_URL, max: 2 });
  let browser = null;

  try {
    const runId = await seedRun(pool);
    console.log(`seeded fixture chat ${runId} into ${dbName}`);
    await assertApiServesSeed(runId);
    console.log(`${FORGE_API_URL} serves it`);

    browser = await chromium.launch({ executablePath, headless: process.env.HEADFUL !== "1" });
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
    });
    // `secure: true` even over http://127.0.0.1: Chrome rejects a __Secure-
    // prefixed cookie at the CDP layer otherwise, and it treats 127.0.0.1 as a
    // secure context so the cookie is still sent.
    await ctx.addCookies([
      {
        name: COOKIE_NAME,
        value: cookieValue,
        domain: new URL(BASE_URL).hostname,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);

    /* Runs before first paint on EVERY navigation, so a reload is how we get
     * back to the Team tab with the fixture chat open.
     *
     * It deliberately does NOT touch `forge.chat.navStack`. An init script's
     * argument is captured at registration, so a script that cleared the key
     * would clear it again on the very navigation meant to restore the drill-in
     * — which is exactly how the first run of this check ended up asserting
     * "summary" against six raw rows. The drill-in is set from the page
     * instead, immediately before the navigation that should honour it. */
    await ctx.addInitScript((id) => {
      localStorage.setItem("forge.desktop.surface", JSON.stringify("chat"));
      localStorage.setItem("forge.chat.selected", JSON.stringify(id));
      localStorage.setItem("forge.layout.chat.panelTab", JSON.stringify("team"));
      localStorage.setItem("forge.layout.chat.panelCollapsed", JSON.stringify(false));
    }, runId);

    /** Enter or leave AgentChatView's drilled worker view — the one place
     *  `mode="summary"` is mounted. `stored-nav.ts` validates this key, so the
     *  shape here is its `StoredNav`, not an approximation of it. */
    const setDrill = async (page, on) =>
      page.evaluate(
        ([id, wantDrill]) => {
          if (wantDrill) {
            localStorage.setItem(
              "forge.chat.navStack",
              JSON.stringify({
                chatId: id,
                frames: [{ kind: "agent", runId: id, label: "fixture worker" }],
              }),
            );
          } else {
            localStorage.removeItem("forge.chat.navStack");
          }
        },
        [runId, on],
      );

    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(Number(process.env.NAV_TIMEOUT_MS ?? 240000));
    const shot = shooter(page);

    /** Land on the chat with the right panel on Team, every time. */
    async function openOnTeamTab(label, { expectMode }) {
      await page.goto(`${BASE_URL}/desktop`, { waitUntil: "commit" });
      const signedIn = await waitFor(page, async () => page.url().includes("/desktop"), {
        timeoutMs: 15000,
      });
      if (!signedIn) throw new HarnessError(`not signed in: landed on ${page.url()}`);
      const rendered = await waitFor(
        page,
        async () => {
          const rows = await toolRows(page).catch(() => []);
          return rows.length >= CALLS.length && rows.every((r) => r.mode === expectMode);
        },
        { timeoutMs: 60000 },
      );
      if (!rendered) {
        await shot(`${label}-rows-missing`);
        const rows = await toolRows(page).catch(() => []);
        throw new HarnessError(
          `expected ${CALLS.length} tool rows in mode "${expectMode}" at ${page.url()}; ` +
            `saw ${rows.length} (${[...new Set(rows.map((r) => r.mode))].join("/") || "none"})`,
        );
      }
      const st = await panelState(page);
      if (st.tab !== JSON.stringify("team")) {
        throw new HarnessError(`panel tab did not start on team, it is ${st.tab}`);
      }
      return st;
    }

    /* ── 1. Which rows offer a click (raw mode, the manager chat) ────────── */

    await openOnTeamTab("t1", { expectMode: "raw" });
    await shot("t1-raw-tool-rows");

    for (const call of CALLS) {
      const row = await rowFor(page, call);
      check(
        `1-${call.id}-${call.openable ? "is" : "is-not"}-openable`,
        row.openable === call.openable,
        call.why,
      );
    }

    /* ── 2. The raw payload slice did not move by a character ────────────── */

    {
      const call = CALLS[0];
      const row = await rowFor(page, call);
      check(
        "2a-raw-preview-text-unchanged",
        row.text.includes(rawPreview(call)),
        "the 110-char payload slice renders exactly as before the affordance existed",
      );
      check(
        "2b-click-target-is-only-the-path",
        row.targetText === call.args.file_path,
        `target text: ${JSON.stringify(row.targetText)}`,
      );
      check(
        "2c-tooltip-names-the-file-and-the-chord",
        typeof row.title === "string" &&
          row.title.includes("Operating Manual.md") &&
          /Ctrl|⌘/.test(row.title),
        row.title ?? "(no title)",
      );
    }

    /* ── 3. Plain click from the TEAM tab opens the file ─────────────────── */

    {
      const call = CALLS[0];
      const before = await panelState(page);
      check(
        "3a-content-marker-absent-before-click",
        !before.bodyText.includes(VAULT_MARKER),
        "negative control: the file's text is not already on screen",
      );
      const pagesBefore = ctx.pages().length;
      const row = await rowFor(page, call);
      await shot("t3-before-click");
      await page
        .locator('[data-tool-row] [data-openable-path][data-openable-source="tool"]')
        .nth(
          (await toolRows(page)).slice(0, row.idx).filter((r) => r.openable).length,
        )
        .click();

      const flipped = await waitFor(page, async () => {
        const st = await panelState(page);
        return st.tab === JSON.stringify("files");
      });
      check("3b-panel-tab-flips-team-to-files", flipped, "ChatSurface switched the right panel");

      const shown = await waitFor(page, async () => {
        const st = await panelState(page);
        return st.bodyText.includes(VAULT_MARKER);
      });
      const after = await panelState(page);
      await shot("t3-after-click-file-open");
      check("3c-file-content-rendered-in-panel", shown, `marker: ${JSON.stringify(VAULT_MARKER)}`);
      check(
        "3d-no-new-browser-tab",
        ctx.pages().length === pagesBefore,
        `tabs: ${pagesBefore} → ${ctx.pages().length}`,
      );
      check(
        "3e-row-did-not-also-expand",
        (await rowFor(page, call)).expanded === false,
        "the click must not fall through to the row's own expand toggle",
      );
      check(
        "3f-panel-shows-the-file-it-opened",
        after.selectedRows.some((r) => r.includes("Operating Manual.md")) ||
          (after.breadcrumbs ?? "").includes("Profile"),
        `selected: ${JSON.stringify(after.selectedRows)} · breadcrumbs: ${after.breadcrumbs}`,
      );
    }

    /* ── 4. Ctrl-click goes to /document in a new tab ────────────────────── */

    {
      await openOnTeamTab("t4", { expectMode: "raw" });
      const call = CALLS[1]; // the forge-src edit
      const row = await rowFor(page, call);
      const idxAmongOpenable = (await toolRows(page)).slice(0, row.idx).filter((r) => r.openable).length;
      const opened = ctx.waitForEvent("page", { timeout: 15000 }).catch(() => null);
      await page
        .locator('[data-tool-row] [data-openable-path][data-openable-source="tool"]')
        .nth(idxAmongOpenable)
        .click({ modifiers: ["Control"] });
      const newPage = await opened;
      // A brand-new tab's `url()` is "" until the navigation commits — reading
      // it straight away measures the race, not the feature.
      if (newPage !== null) {
        await newPage.waitForLoadState("domcontentloaded").catch(() => {});
        await waitFor(page, async () => newPage.url() !== "" && newPage.url() !== "about:blank");
      }
      const url = newPage === null ? "(no new tab)" : newPage.url();
      check(
        "4a-ctrl-click-opens-the-document-viewer-in-a-new-tab",
        newPage !== null && url.includes("/document?root=forge-src&path="),
        url,
      );
      if (newPage !== null) await newPage.close();
    }

    /* ── 5. Summary mode (the drilled worker view) does the same ─────────── */

    {
      await setDrill(page, true);
      const st = await openOnTeamTab("t5", { expectMode: "summary" });
      await shot("t5-summary-tool-rows");
      check(
        "5a-summary-mode-negative-control",
        !st.bodyText.includes(VAULT_MARKER),
        "the file's text is not on screen before the click",
      );
      const call = CALLS[0];
      const row = await rowFor(page, call);
      check(
        "5b-summary-row-is-openable",
        row.openable === true,
        `gist: ${JSON.stringify(row.targetText)}`,
      );
      check(
        "5c-summary-target-is-the-shortened-gist-not-the-raw-payload",
        typeof row.targetText === "string" && row.targetText.startsWith("…/"),
        row.targetText ?? "(none)",
      );
      const pagesBefore = ctx.pages().length;
      await page
        .locator('[data-tool-row="summary"] [data-openable-path][data-openable-source="tool"]')
        .nth((await toolRows(page)).slice(0, row.idx).filter((r) => r.openable).length)
        .click();
      const shown = await waitFor(page, async () => {
        const s = await panelState(page);
        return s.tab === JSON.stringify("files") && s.bodyText.includes(VAULT_MARKER);
      });
      await shot("t5-after-click-file-open");
      check("5d-summary-mode-click-opens-the-file", shown, "tab flipped AND the text is on screen");
      check(
        "5e-summary-mode-no-new-tab",
        ctx.pages().length === pagesBefore,
        `tabs: ${pagesBefore} → ${ctx.pages().length}`,
      );
    }
  } finally {
    if (browser !== null) await browser.close().catch(() => {});
    await pool.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILURE(S)`} — ${results.length} assertions`,
  );
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof HarnessError) {
      console.error(`\nHARNESS FAULT (the test did not run — this is not a pass):\n  ${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(2);
  });
