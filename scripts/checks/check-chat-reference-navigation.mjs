#!/usr/bin/env node
/**
 * Regression test for chat reference navigation — the wiring, in a real browser.
 *
 * WHY THIS EXISTS. Every bug this feature has shipped was wiring between
 * components that each worked perfectly alone, and every one of them was
 * invisible to `tsc`, to the unit check (`check-code-path-link.ts`) and to a
 * grep of the bundle:
 *
 *   1. The open-file bus had no latch, so the click dispatched BEFORE
 *      `FileExplorerPanel` mounted (it only mounts on the Files tab, and Team
 *      is the default). Tab flipped, file never opened.
 *   2. Resolution searched by full path against `/files/search`, which matches
 *      on `name.toLowerCase().includes(q)` — so any query containing "/"
 *      matched nothing, ever.
 *   3. A miss was silent, which is indistinguishable from a dead handler.
 *
 * So the assertion is never "the component renders". It is: CLICK A PILL FROM
 * THE TEAM TAB and observe the tab flip, the breadcrumbs, the selected row,
 * the file's own text on screen, and the browser's tab count staying at one.
 *
 * ZERO LIVE WRITES BY CONSTRUCTION. The test seeds its own chat, and it refuses
 * to seed into the live database unless ALLOW_LIVE_SEED=1 is set explicitly.
 * The intended stack is a probe forge-control mounting only the chat router
 * against a scratch database, proxying everything else read-only to :7700 —
 * see docs/plan/artifacts/chat-ref-nav/README.md for the four commands.
 *
 * INPUTS (environment)
 *   BASE_URL           the console under test        (default http://127.0.0.1:7802)
 *   FORGE_API_URL      the forge-control it talks to (default http://127.0.0.1:7801)
 *   SEED_DATABASE_URL  the database FORGE_API_URL's chat router reads (required)
 *   AUTH_SECRET        to mint a session cookie   (or FORGE_SESSION_COOKIE, pre-minted)
 *   COOKIE_NAME        session cookie name (default __Secure-authjs.session-token)
 *   OUT_DIR            screenshots (default /opt/ai-os/uploads/$FORGE_RUN_ID)
 *   ALLOW_LIVE_SEED=1  permit seeding into content_forge (deploy task only)
 *   KEEP_SEED=1        do not delete the seeded run afterwards
 *   HEADFUL=1          watch it run
 *
 * EXIT: 0 iff every named assertion passed; 1 on any FAIL; 2 on a harness fault
 * (dependency missing, not signed in, seeded chat not served) — a harness fault
 * is NOT a green run and is never swallowed.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/* ── Inputs ─────────────────────────────────────────────────────────────── */

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:7802").replace(/\/+$/, "");
const FORGE_API_URL = (process.env.FORGE_API_URL ?? "http://127.0.0.1:7801").replace(/\/+$/, "");
const SEED_DATABASE_URL = process.env.SEED_DATABASE_URL ?? "";
const COOKIE_NAME = process.env.COOKIE_NAME ?? "__Secure-authjs.session-token";
const OUT_DIR =
  process.env.OUT_DIR ??
  (process.env.FORGE_RUN_ID
    ? `/opt/ai-os/uploads/${process.env.FORGE_RUN_ID}`
    : path.join(process.cwd(), "chat-ref-nav-shots"));

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

/** A harness fault: the test could not be run, which is not the same as a
 *  failing assertion and must never be reported as one. */
class HarnessError extends Error {}

/* ── Dependency resolution ──────────────────────────────────────────────────
 *
 * playwright, pg and @auth/core are NOT dependencies of this repo and must
 * never become ones (playwright would drag a browser download into every
 * install). They are borrowed from where they already live on this box, by
 * explicit path, and every miss throws with the path it looked at. */

function requireFile(p, what, hint) {
  if (!existsSync(p)) {
    throw new HarnessError(`${what} not found at ${p}\n  ${hint}`);
  }
  return p;
}

function playwrightEntry() {
  const p = process.env.PLAYWRIGHT_MODULE ?? "/opt/hermes-workspace/node_modules/playwright/index.mjs";
  return requireFile(
    p,
    "playwright",
    "set PLAYWRIGHT_MODULE to a playwright index.mjs. Do NOT add playwright to this repo.",
  );
}

/**
 * The installed chromium revision is not the one playwright asks for (1234 vs
 * 1223 today), and `chromium.launch()` with no executablePath then throws
 * "Please run: npx playwright install" — which must NOT be run. Scan instead.
 */
function chromeExecutable() {
  if (process.env.CHROME_PATH) {
    return requireFile(process.env.CHROME_PATH, "CHROME_PATH", "point it at a chrome binary");
  }
  const cache = "/root/.cache/ms-playwright";
  if (!existsSync(cache)) {
    throw new HarnessError(`no playwright browser cache at ${cache}; set CHROME_PATH`);
  }
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
  if (!dir) {
    throw new HarnessError(`no @auth+core@* package under ${store}`);
  }
  return requireFile(
    path.join(store, dir, "node_modules", "@auth", "core", "jwt.js"),
    "@auth/core jwt.js",
    "the console's next-auth version moved; update this path",
  );
}

function pgModule() {
  const p = path.join(REPO_ROOT, "forge-control", "node_modules", "pg", "lib", "index.js");
  return requireFile(
    p,
    "pg",
    "run: cd forge-control && pnpm install --frozen-lockfile --prod=false",
  );
}

/* ── The fixture ────────────────────────────────────────────────────────────
 *
 * Five pills, one per branch of `detectPath` + the resolver. Each `expect`
 * records what the feature is supposed to do with it, so a change in the
 * detector shows up here as a named FAIL rather than as a missing element. */

const PILLS = {
  /** (a) absolute, inside the forge-src root — resolves without a search. */
  absForgeSrc: "/opt/forge-ai-os/docs/plan/03-quality.md",
  /** (b) absolute, inside the vault root. */
  absVault: "/opt/obsidian-vault/Mentor/Profile/Operating Manual.md",
  /** (c) absolute, outside EVERY root — must not be offered as a click. */
  absOutside: "/opt/nowhere/missing-file.md",
  /** (d) the same file as (b), written relative — placed by /files/search. */
  relVault: "Mentor/Profile/Operating Manual.md",
  /** (e) openable-looking, resolvable by nothing — must toast, not go quiet. */
  relMissing: "definitely-not-a-real-note-xyz.md",
  /** (f) D1 — `path:line`. Relative, so it resolves by search like (d); the
   *  line comes off BEFORE the extension test in detectPath, and back on
   *  after resolution, all the way to a highlighted row in FilePreview. */
  lineRef: "forge-control-web/app/desktop/chat/MessageMarkdown.tsx:160",
  /** (g) D5 — a trailing-slash directory reference. Real dir, checked to
   *  exist at fixture-authoring time (README §"first results" appendix). */
  folder: "/opt/ai-os/scripts/",
  /** (h) D6 — the fleet memory root. Absolute, matches the client's static
   *  prefix table regardless of whether the server has restarted into a
   *  router that actually serves it — that gap is the whole point of the
   *  case (see §11 below, which asks /api/files/roots which branch applies). */
  memoryFile: "/root/.claude/projects/-opt-forge-ai-os/memory/MEMORY.md",
  /** (i)/(j) — PLAN.md finding 6, false affordances a bare extension or an
   *  extension LIST must never become. `detectPath` rejects any token
   *  starting with "." before it ever reaches the extension test. */
  extDot: ".txt",
  extList: ".md .txt .json .csv",
};

/** D2 — a wikilink is prose, not a code pill, so it lives in the message body
 *  rather than in PILLS/backticks. The vault note is the SAME file as (b)/(d)
 *  above: one target, three ways an agent might reference it. */
const WIKILINK_NAME = "Operating Manual";
const WIKILINK_TEXT = `[[${WIKILINK_NAME}]]`;

/** Text that exists in the target files and NOWHERE in the chat itself, so
 *  "is it on screen" is a discriminating question. Asserted absent before the
 *  click and present after — a check that can only pass one way round. */
/** How long a click may take to say "I couldn't find that" before the console
 *  is, from Konrad's side of the screen, simply not responding. This is the
 *  UX bar (assertion 6b), NOT the harness's patience. */
const MISS_BUDGET_MS = Number(process.env.MISS_BUDGET_MS ?? 8000);

/**
 * The harness's patience (assertion 6a), which must be far beyond the bar or
 * the two questions collapse back into one. Measured across five runs on a
 * loaded box: 29.7 s, 48.8 s, 58.0 s, 64.6 s, 90.4 s — the miss walks five
 * roots serially, two of them large trees, and gets slower as the box fills
 * up. At 90 s the timeout itself started failing the run, which reports "the
 * feature never told me" when what happened was "the harness gave up first".
 */
const MISS_TIMEOUT_MS = Number(process.env.MISS_TIMEOUT_MS ?? 240000);

const CONTENT_MARKERS = {
  absForgeSrc: "Quality: test strategy and QA gates",
  absVault: "How to Work With Konrad",
  /** D1 fixture. A stable top-of-file import, chosen deliberately instead of
   *  anything near line 160 itself: the exact text at that line in the LIVE
   *  checkout drifts with every round that edits the file, but the import
   *  line does not, and the assertion only needs to know the right FILE
   *  rendered — the highlighted-row assertion is what proves the right LINE. */
  lineRef: "ReactMarkdown",
};

const SEED_MESSAGE = [
  "Chat reference navigation regression fixture. Each pill below is one case.",
  "",
  `- exact, forge-src root: \`${PILLS.absForgeSrc}\``,
  `- exact, vault root: \`${PILLS.absVault}\``,
  `- outside every root: \`${PILLS.absOutside}\``,
  `- relative, resolved by search: \`${PILLS.relVault}\``,
  `- resolvable by nothing: \`${PILLS.relMissing}\``,
  `- line reference (D1): \`${PILLS.lineRef}\``,
  `- folder (D5): \`${PILLS.folder}\``,
  `- fleet memory (D6): \`${PILLS.memoryFile}\``,
  `- wikilink (D2), the same note as above: ${WIKILINK_TEXT}`,
  "",
  "Not a path, must stay a plain pill: `pnpm install`, `spend.per_run_cap`, " +
    `\`${PILLS.extDot}\`, \`${PILLS.extList}\`.`,
].join("\n");

/* ── Assertion ledger ───────────────────────────────────────────────────── */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/* ── Seeding ────────────────────────────────────────────────────────────── */

async function seedRun(pool) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const thread = [
    { role: "user", content: "Show me the reference-navigation fixture.", ts: now, kind: "text" },
    { role: "assistant", content: SEED_MESSAGE, ts: now, kind: "text" },
  ];
  await pool.query(
    `INSERT INTO runs (id, title, prompt, worker, status, thread, budget_usd, spent_usd, metadata,
                       created_at, updated_at, started_at, completed_at)
     VALUES ($1::uuid, $2, $3, 'probe', 'completed', $4::jsonb, 0, 0, $5::jsonb,
             now(), now(), now(), now())`,
    [
      id,
      "chat-ref-nav regression fixture",
      "Show me the reference-navigation fixture.",
      JSON.stringify(thread),
      JSON.stringify({ probe: true, check: "check-chat-reference-navigation" }),
    ],
  );
  return id;
}

/**
 * The seeded row and the API the browser will read MUST be the same database.
 * Seeding a scratch DB while FORGE_API_URL still points at :7700 would leave
 * the console showing some other chat entirely, and every pill assertion would
 * fail for a reason that has nothing to do with the feature.
 */
async function assertApiServesSeed(runId) {
  const url = `${FORGE_API_URL}/api/chat/${runId}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new HarnessError(
      `${url} → HTTP ${res.status}. The run was seeded into SEED_DATABASE_URL but ` +
        "FORGE_API_URL does not serve it — the two are different databases.",
    );
  }
  const body = await res.json();
  const thread = body?.run?.thread;
  if (!Array.isArray(thread) || !thread.some((e) => String(e.content).includes(PILLS.absForgeSrc))) {
    throw new HarnessError(
      `${url} served a run without the fixture message (thread entries: ${
        Array.isArray(thread) ? thread.length : "none"
      })`,
    );
  }
}

/* ── Browser helpers ────────────────────────────────────────────────────── */

const stamp = () =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

function shooter(page) {
  return async (label) => {
    const file = path.join(OUT_DIR, `${stamp()}-${label}.png`);
    await page.screenshot({ path: file });
    console.log(`    shot ${file}`);
    return file;
  };
}

/**
 * All `code` pills on the page with their exact text and openability, in DOM
 * order — which is the order `page.locator("code").nth(i)` uses, so the index
 * is a stable handle. Exact text matters: the relative pill (d) is a substring
 * of the absolute pill (b), and `hasText` would silently pick the wrong one.
 */
async function pills(page) {
  return page.$$eval("code", (els) =>
    els.map((e) => ({
      text: (e.textContent ?? "").trim(),
      openable: e.hasAttribute("data-openable-path"),
    })),
  );
}

async function pillIndex(page, exact) {
  const all = await pills(page);
  const idx = all.findIndex((p) => p.text === exact);
  if (idx === -1) {
    throw new HarnessError(
      `pill ${JSON.stringify(exact)} is not in the DOM. Pills present:\n    ` +
        all.map((p) => `${p.openable ? "[openable] " : "           "}${p.text}`).join("\n    "),
    );
  }
  return idx;
}

async function readLocalStorage(page, key) {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

/**
 * Everything the Files panel is currently saying, in one round trip.
 *
 * `selectedCount` and `selectedRows` are DELIBERATELY separate questions. The
 * panel's list is virtualised (`@tanstack/react-virtual`), so a file can be
 * selected — preview rendered, header reading "1 selected" — while its row is
 * not in the DOM at all because nothing scrolled it into view. Folding the two
 * together would report one defect as two, or hide it entirely in a directory
 * small enough to fit the window.
 */
async function panelState(page) {
  return page.evaluate(() => {
    const countText = Array.from(document.querySelectorAll("span"))
      .map((s) => (s.textContent ?? "").trim())
      .find((t) => /^\d+ selected$/.test(t));

    /* "Revealed" means a human can see it, which is NOT the same as being in
     * the DOM. The list scrolls inside a fixed-height box, so a selected row
     * can sit hundreds of pixels below the fold with its class intact — that
     * is what `Mentor/Profile` does: `About Me.md` and `Current Chapter.md`
     * fill the visible box and the selected `Operating Manual.md` is out of
     * sight. An assertion that only queried the class would go green on a
     * screen where the file Konrad opened is nowhere to be found. So compare
     * the row's rect against its scroll container's rect. */
    const rows = Array.from(document.querySelectorAll(".vfl-row--selected"));
    const revealed = rows.filter((row) => {
      let box = row.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 4)) box = box.parentElement;
      if (!box) return true; // nothing scrolls: if it is in the DOM it is on screen
      const r = row.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    });

    return {
      breadcrumbs: document.querySelector(".vfl-breadcrumbs")?.textContent?.trim() ?? null,
      selectedCount: countText ? Number(countText.split(" ")[0]) : null,
      selectedRows: rows.map((r) => (r.textContent ?? "").trim()),
      revealedRows: revealed.map((r) => (r.textContent ?? "").trim()),
      rowsRendered: document.querySelectorAll(".vfl-row").length,
      bodyText: document.body.innerText,
    };
  });
}

/** One line of evidence for a reveal assertion: what is selected, what of that
 *  is actually on screen, and out of how many rendered rows. */
function revealDetail(state) {
  return (
    `selected in DOM = ${JSON.stringify(state.selectedRows)}, ` +
    `visible in the list box = ${JSON.stringify(state.revealedRows)}, ` +
    `${state.rowsRendered} rows rendered`
  );
}

/** Poll for a condition instead of sleeping a fixed time — a toast lives ~4s
 *  and a fixed wait either misses it or wastes the run. Returns false on
 *  timeout; the caller decides whether that is a FAIL. */
async function waitFor(page, fn, { timeoutMs = 12000, stepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(stepMs);
  }
}

/**
 * D1's evidence: does the code viewer have a row for `data-line`, does it
 * carry the highlight class, and — the part a DOM query alone would miss —
 * is that row's rectangle actually inside the `.fp-code-scroll` box it
 * scrolls in. Same "in the DOM is not on screen" caveat `panelState`'s
 * `revealedRows` exists for, applied to `CodeViewer` instead of `VaultFileList`.
 */
async function codeViewerHitState(page, line) {
  return page.evaluate((n) => {
    const row = document.querySelector(`.fp-code-row[data-line="${n}"]`);
    if (!row) return { present: false, hit: false, inViewport: false, rowCount: 0 };
    const box = row.closest(".fp-code-scroll");
    let inViewport = true;
    if (box) {
      const r = row.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      inViewport = r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    }
    return {
      present: true,
      hit: row.classList.contains("fp-code-row-hit"),
      inViewport,
      rowCount: document.querySelectorAll(".fp-code-row").length,
    };
  }, line);
}

/** D3's evidence: the meta strip's key/value pairs, and the body text with
 *  the strip's own text excluded — so "does the body start with the raw
 *  frontmatter" is a question about `.fp-scroll` alone, not about a screen
 *  that also happens to contain the word "type" in the meta strip above it. */
async function metaStripState(page) {
  return page.evaluate(() => {
    const meta = document.querySelector(".fp-meta");
    const keys = meta
      ? Array.from(meta.querySelectorAll(".fp-meta-key")).map((k) => (k.textContent ?? "").trim())
      : [];
    const bodyText = (document.querySelector(".fp-scroll")?.textContent ?? "").trim();
    return { present: meta !== null, keys, bodyStart: bodyText.slice(0, 40) };
  });
}

/** D6's dynamic branch. The client's static prefix table (`code-path-link.ts`)
 *  offers the `memory` root regardless of server state — that is deliberate,
 *  see `resolve-path.ts`'s `resolveRootPath` — so the ONLY way to know which
 *  half of the case applies is to ask the same endpoint the app itself asks. */
async function fetchLiveRootKeys(apiUrl) {
  const res = await fetch(`${apiUrl}/api/files/roots`);
  if (!res.ok) {
    throw new HarnessError(`${apiUrl}/api/files/roots → HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!Array.isArray(body?.roots)) {
    throw new HarnessError(`${apiUrl}/api/files/roots returned no "roots" array`);
  }
  return new Set(body.roots.map((r) => r.key));
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
        "  Use a scratch database (README §1), or set ALLOW_LIVE_SEED=1 if you are the\n" +
        "  deploy task and you intend to delete the row afterwards.",
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
    // The salt MUST equal the cookie name: in next-auth v5 it is part of the
    // key derivation, and a mismatch fails auth SILENTLY — the middleware then
    // 307s to /signin, which still answers HTTP 200 and reads as a clean run.
    cookieValue = await encode({
      token: { name: "chat-ref-nav check", email: "probe@local", sub: "probe" },
      secret: process.env.AUTH_SECRET,
      salt: COOKIE_NAME,
      maxAge: 3600,
    });
  }

  const pool = new pg.Pool({ connectionString: SEED_DATABASE_URL, max: 2 });
  let runId = null;
  let browser = null;

  try {
    runId = await seedRun(pool);
    console.log(`seeded fixture chat ${runId} into ${dbName}`);
    await assertApiServesSeed(runId);
    console.log(`${FORGE_API_URL} serves it`);

    browser = await chromium.launch({ executablePath, headless: process.env.HEADFUL !== "1" });
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
    });
    // `secure: true` even over http://127.0.0.1: Chrome rejects a __Secure-
    // prefixed cookie outright at the CDP layer otherwise ("Invalid cookie
    // fields", naming no field), and it treats 127.0.0.1 as a secure context
    // so the cookie is still sent.
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
    // Runs before first paint, on every navigation — so a reload is how we get
    // back to the Team tab after a click has flipped it to Files.
    await ctx.addInitScript((id) => {
      localStorage.setItem("forge.desktop.surface", JSON.stringify("chat"));
      localStorage.setItem("forge.chat.selected", JSON.stringify(id));
      localStorage.setItem("forge.layout.chat.panelTab", JSON.stringify("team"));
      localStorage.setItem("forge.layout.chat.panelCollapsed", JSON.stringify(false));
    }, runId);

    const page = await ctx.newPage();
    // A COLD `next dev` compiles /desktop on the first authenticated request
    // and that took 110 s here (7546 modules). Playwright's 30 s default turns
    // that into "Timeout 30000ms exceeded", which reads as a dead console.
    page.setDefaultNavigationTimeout(Number(process.env.NAV_TIMEOUT_MS ?? 240000));
    const shot = shooter(page);

    /** Land on the chat with the right panel on Team, every time. */
    async function openOnTeamTab(label) {
      await page.goto(`${BASE_URL}/desktop`, { waitUntil: "commit" });
      // An expired or wrongly-salted cookie 307s to /signin — with HTTP 200.
      // Assert the landing URL or every later measurement is a fiction.
      const ok = await waitFor(page, async () => page.url().includes("/desktop"), {
        timeoutMs: 15000,
      });
      if (!ok) throw new HarnessError(`not signed in: landed on ${page.url()}`);
      const present = await waitFor(page, async () => {
        const all = await pills(page).catch(() => []);
        return all.some((p) => p.text === PILLS.absForgeSrc);
      }, { timeoutMs: 30000 });
      if (!present) {
        await shot(`${label}-thread-missing`);
        throw new HarnessError(
          `the fixture message never rendered at ${page.url()} (chat ${runId}). ` +
            "Is BASE_URL's FORGE_CONTROL_URL pointed at FORGE_API_URL?",
        );
      }
      const tab = await readLocalStorage(page, "forge.layout.chat.panelTab");
      if (tab !== JSON.stringify("team")) {
        throw new HarnessError(`panel tab did not start on team, it is ${tab}`);
      }
      return panelState(page);
    }

    /* ── 1. Affordance: openable iff the path is inside a root ───────────── */

    await openOnTeamTab("a1");
    await shot("a1-team-tab-fixture");
    const all = await pills(page);
    const byText = (t) => all.find((p) => p.text === t);
    check(
      "1a-abs-forge-src-pill-is-openable",
      byText(PILLS.absForgeSrc)?.openable === true,
      PILLS.absForgeSrc,
    );
    check(
      "1b-abs-vault-pill-is-openable",
      byText(PILLS.absVault)?.openable === true,
      PILLS.absVault,
    );
    check(
      "1c-outside-every-root-pill-is-not-openable",
      byText(PILLS.absOutside) !== undefined && byText(PILLS.absOutside).openable === false,
      `${PILLS.absOutside} (present as a plain pill: ${byText(PILLS.absOutside) !== undefined})`,
    );
    check(
      "1d-command-pill-is-not-openable",
      byText("pnpm install")?.openable === false,
      "`pnpm install` must stay a plain pill",
    );
    check(
      "1e-bare-extension-pill-is-not-openable",
      byText(PILLS.extDot) !== undefined && byText(PILLS.extDot).openable === false,
      `\`${PILLS.extDot}\` — a token starting with "." is an extension, not a name`,
    );
    check(
      "1f-extension-list-pill-is-not-openable",
      byText(PILLS.extList) !== undefined && byText(PILLS.extList).openable === false,
      `\`${PILLS.extList}\` — PLAN.md finding 6's exact false positive`,
    );

    /* ── 2. Plain click on (a) from the Team tab ─────────────────────────── */

    {
      const before = await panelState(page);
      check(
        "2a-content-marker-absent-before-click",
        !before.bodyText.includes(CONTENT_MARKERS.absForgeSrc),
        "negative control: the file's text is not already on screen",
      );
      const pagesBefore = ctx.pages().length;
      await shot("a2-before-click-forge-src");
      const idx = await pillIndex(page, PILLS.absForgeSrc);
      await page.locator("code").nth(idx).click();

      await waitFor(page, async () =>
        (await readLocalStorage(page, "forge.layout.chat.panelTab")) === JSON.stringify("files"),
      );
      const tabAfter = await readLocalStorage(page, "forge.layout.chat.panelTab");
      check("2b-panel-tab-flips-team-to-files", tabAfter === JSON.stringify("files"), `= ${tabAfter}`);

      await waitFor(page, async () =>
        (await panelState(page)).bodyText.includes(CONTENT_MARKERS.absForgeSrc),
      );
      const after = await panelState(page);
      await shot("a3-after-click-forge-src");

      // Navigation and labelling are two claims, so they are two assertions.
      // Either crumb text ("forge-src" or "forge-control source") proves the
      // panel navigated; only the second proves it is readable.
      check(
        "2c-breadcrumbs-navigated-to-forge-src-docs-plan",
        Boolean(
          after.breadcrumbs &&
            /forge-src|forge-control source/i.test(after.breadcrumbs) &&
            /\bdocs\b/.test(after.breadcrumbs) &&
            /\bplan\b/.test(after.breadcrumbs),
        ),
        `breadcrumbs = ${JSON.stringify(after.breadcrumbs)}`,
      );
      check(
        "2d-breadcrumbs-show-the-human-root-label",
        Boolean(after.breadcrumbs && /forge-control source/i.test(after.breadcrumbs)),
        `breadcrumbs = ${JSON.stringify(after.breadcrumbs)} — "forge-src" is the internal ` +
          "root key; the label is only known once fetchFileRoots has landed",
      );
      check(
        "2e-no-new-browser-tab",
        ctx.pages().length === pagesBefore,
        `${pagesBefore} → ${ctx.pages().length}`,
      );
      check(
        "2f-file-content-rendered-in-preview",
        after.bodyText.includes(CONTENT_MARKERS.absForgeSrc),
        `looked for ${JSON.stringify(CONTENT_MARKERS.absForgeSrc)}`,
      );
      check(
        "2g-opened-file-registers-as-selected",
        after.selectedCount === 1,
        `panel header says ${JSON.stringify(after.selectedCount)} selected`,
      );
      check(
        "2h-opened-row-is-revealed-in-the-list",
        after.revealedRows.some((r) => r.includes("03-quality.md")),
        `${revealDetail(after)} — the list is virtualised and nothing scrolls the ` +
          "entry into view (PLAN D4)",
      );
    }

    /* ── 3. Plain click on (b), the vault note ───────────────────────────── */

    {
      await openOnTeamTab("b1");
      const before = await panelState(page);
      check(
        "3a-vault-marker-absent-before-click",
        !before.bodyText.includes(CONTENT_MARKERS.absVault),
        "negative control",
      );
      await shot("b2-before-click-vault-abs");
      const idx = await pillIndex(page, PILLS.absVault);
      await page.locator("code").nth(idx).click();
      await waitFor(page, async () =>
        (await panelState(page)).bodyText.includes(CONTENT_MARKERS.absVault),
      );
      const after = await panelState(page);
      await shot("b3-after-click-vault-abs");
      check(
        "3b-vault-note-content-rendered",
        after.bodyText.includes(CONTENT_MARKERS.absVault),
        `breadcrumbs = ${JSON.stringify(after.breadcrumbs)}`,
      );
      check(
        "3c-vault-row-is-revealed-in-the-list",
        after.revealedRows.some((r) => r.includes("Operating Manual.md")),
        revealDetail(after),
      );
    }

    /* ── 4. Plain click on (d), the same file written relative ───────────── */

    {
      await openOnTeamTab("c1");
      await shot("c2-before-click-vault-relative");
      const idx = await pillIndex(page, PILLS.relVault);
      const startedAt = Date.now();
      await page.locator("code").nth(idx).click();
      // This one goes through /files/search — the path that was broken for
      // every query containing a slash. Give it the full budget.
      await waitFor(
        page,
        async () => (await panelState(page)).bodyText.includes(CONTENT_MARKERS.absVault),
        { timeoutMs: 30000 },
      );
      const elapsedMs = Date.now() - startedAt;
      const after = await panelState(page);
      await shot("c3-after-click-vault-relative");
      check(
        "4a-relative-path-resolves-via-search",
        after.bodyText.includes(CONTENT_MARKERS.absVault),
        `breadcrumbs = ${JSON.stringify(after.breadcrumbs)}, after ${(elapsedMs / 1000).toFixed(1)}s`,
      );
      check(
        "4b-relative-path-selects-the-same-file",
        after.selectedRows.some((r) => r.includes("Operating Manual.md")),
        `${revealDetail(after)} — selection only; reveal is asserted by 3c`,
      );
    }

    /* ── 5. Ctrl-click on (a) → exactly one new tab, on /document ────────── */

    {
      await openOnTeamTab("d1");
      await shot("d2-before-ctrl-click");
      const pagesBefore = ctx.pages().length;
      const idx = await pillIndex(page, PILLS.absForgeSrc);
      const popupPromise = ctx.waitForEvent("page", { timeout: 15000 }).catch(() => null);
      await page.locator("code").nth(idx).click({ modifiers: ["Control"] });
      const popup = await popupPromise;
      // Give a second, unwanted tab time to appear before counting.
      await page.waitForTimeout(2000);
      const opened = ctx.pages().length - pagesBefore;
      const url = popup ? popup.url() : "(no new page)";
      check("5a-ctrl-click-opens-exactly-one-new-tab", opened === 1, `opened ${opened}, url ${url}`);
      check(
        "5b-new-tab-is-the-document-viewer-on-forge-src",
        popup !== null && new URL(url).pathname === "/document" &&
          new URL(url).searchParams.get("root") === "forge-src",
        url,
      );
      if (popup) {
        await popup.waitForTimeout(3000);
        const f = path.join(OUT_DIR, `${stamp()}-d3-ctrl-click-document-tab.png`);
        await popup.screenshot({ path: f });
        console.log(`    shot ${f}`);
        await popup.close();
      }
    }

    /* ── 6. A miss must say so ───────────────────────────────────────────── */

    {
      await openOnTeamTab("e1");
      await shot("e2-before-click-unresolvable");
      const idx = await pillIndex(page, PILLS.relMissing);
      const startedAt = Date.now();
      await page.locator("code").nth(idx).click();
      // The toast is `Couldn't find <name>` and lives ~4 s, so poll rather than
      // sleep. There is no stable selector on ToastHost; the message string
      // appears nowhere else in the console, which makes body text a
      // discriminating instrument here.
      //
      const toasted = await waitFor(
        page,
        async () => (await page.evaluate(() => document.body.innerText)).includes("Couldn't find"),
        { timeoutMs: MISS_TIMEOUT_MS, stepMs: 200 },
      );
      const elapsedMs = Date.now() - startedAt;
      await shot("e3-after-click-unresolvable");
      check(
        "6a-unresolvable-pill-toasts-instead-of-going-silent",
        toasted,
        toasted
          ? `pill ${PILLS.relMissing}, after ${(elapsedMs / 1000).toFixed(1)}s`
          : `nothing said "Couldn't find" within the harness's ${MISS_TIMEOUT_MS / 1000}s ` +
            "patience — raise MISS_TIMEOUT_MS before concluding the miss is silent",
      );
      check(
        "6b-miss-is-reported-fast-enough-to-feel-alive",
        toasted && elapsedMs <= MISS_BUDGET_MS,
        `${(elapsedMs / 1000).toFixed(1)}s against a ${MISS_BUDGET_MS / 1000}s budget — ` +
          "five roots are searched serially with no pending state, so the click looks dead " +
          "meanwhile (PLAN: 'resolution longer than ~1 s shows a pending state')",
      );
    }

    /* ── 7. D1 — `path:line` resolves, scrolls, and highlights ───────────── */

    {
      await openOnTeamTab("f1");
      await shot("f2-before-click-line-ref");
      const idx = await pillIndex(page, PILLS.lineRef);
      check(
        "7a-line-ref-pill-is-openable",
        (await pills(page))[idx]?.openable === true,
        PILLS.lineRef,
      );
      await page.locator("code").nth(idx).click();
      await waitFor(page, async () =>
        (await panelState(page)).bodyText.includes(CONTENT_MARKERS.lineRef),
      );
      const after = await panelState(page);
      const hit = await waitFor(
        page,
        async () => (await codeViewerHitState(page, 160)).hit,
        { timeoutMs: 10000 },
      ).then(() => codeViewerHitState(page, 160));
      await shot("f3-after-click-line-ref");
      check(
        "7b-line-ref-file-content-rendered",
        after.bodyText.includes(CONTENT_MARKERS.lineRef),
        `looked for ${JSON.stringify(CONTENT_MARKERS.lineRef)} — proves the FILE, not the line`,
      );
      check(
        "7c-line-160-row-is-highlighted",
        hit.present && hit.hit,
        `data-line="160" present=${hit.present} hit=${hit.hit} of ${hit.rowCount} rows rendered`,
      );
      check(
        "7d-highlighted-row-is-in-the-code-viewport",
        hit.inViewport,
        "CodeViewer's own scrollIntoView({block:'center'}) must have run — a row that is " +
          "highlighted but never scrolled to is D4's failure mode, one component over",
      );
      check(
        "7e-line-ref-row-is-revealed-in-the-file-list",
        after.revealedRows.some((r) => r.includes("MessageMarkdown.tsx")),
        `${revealDetail(after)} — same D4 reveal requirement as 2h/3c, exercised on a ` +
          "different (large) directory",
      );
    }

    /* ── 8. D2 — a wikilink opens the same note by prose syntax ──────────── */

    {
      await openOnTeamTab("g1");
      const before = await panelState(page);
      check(
        "8a-vault-marker-absent-before-wikilink-click",
        !before.bodyText.includes(CONTENT_MARKERS.absVault),
        "negative control",
      );
      const link = page.locator('a[data-openable-kind="wikilink"]');
      const href = await link.getAttribute("href");
      check(
        "8b-wikilink-renders-as-an-anchor-into-document",
        typeof href === "string" && href.startsWith("/document?wikilink="),
        `href = ${JSON.stringify(href)}`,
      );
      await shot("g2-before-click-wikilink");
      await link.click();
      await waitFor(page, async () =>
        (await panelState(page)).bodyText.includes(CONTENT_MARKERS.absVault),
      );
      const after = await panelState(page);
      await shot("g3-after-click-wikilink");
      check(
        "8c-wikilink-opens-the-note-in-the-panel",
        after.bodyText.includes(CONTENT_MARKERS.absVault),
        `breadcrumbs = ${JSON.stringify(after.breadcrumbs)}`,
      );
      check(
        "8d-wikilink-row-is-revealed-in-the-list",
        after.revealedRows.some((r) => r.includes("Operating Manual.md")),
        revealDetail(after),
      );

      /* D3, on the same note: the meta strip vs. the raw frontmatter it must
       * never leak into the rendered body. */
      const meta = await metaStripState(page);
      check(
        "8e-frontmatter-renders-as-a-meta-strip",
        meta.present && meta.keys.includes("type"),
        `strip present=${meta.present}, keys=${JSON.stringify(meta.keys)}`,
      );
      check(
        "8f-body-does-not-start-with-raw-frontmatter",
        !/^type:/i.test(meta.bodyStart),
        `.fp-scroll starts with ${JSON.stringify(meta.bodyStart)}`,
      );
    }

    /* ── 9. D2, Ctrl-click — the wikilink keeps the universal "new tab" ───── */

    {
      await openOnTeamTab("h1");
      await shot("h2-before-ctrl-click-wikilink");
      const pagesBefore = ctx.pages().length;
      const link = page.locator('a[data-openable-kind="wikilink"]');
      const popupPromise = ctx.waitForEvent("page", { timeout: 15000 }).catch(() => null);
      await link.click({ modifiers: ["Control"] });
      const popup = await popupPromise;
      await page.waitForTimeout(2000);
      const opened = ctx.pages().length - pagesBefore;
      // A brand-new tab's url() is "" until it commits — wait for it before
      // reading it, or the assertion measures the popup's blank starting page.
      if (popup) await popup.waitForLoadState("domcontentloaded").catch(() => {});
      const url = popup ? popup.url() : "(no new page)";
      check("9a-ctrl-click-wikilink-opens-exactly-one-new-tab", opened === 1, `opened ${opened}, url ${url}`);
      check(
        "9b-new-tab-is-the-document-viewer-with-the-wikilink-param",
        popup !== null && new URL(url).pathname === "/document" &&
          new URL(url).searchParams.get("wikilink") === WIKILINK_NAME,
        url,
      );
      if (popup) {
        await popup.waitForTimeout(3000);
        const f = path.join(OUT_DIR, `${stamp()}-h3-ctrl-click-wikilink-tab.png`);
        await popup.screenshot({ path: f });
        console.log(`    shot ${f}`);
        await popup.close();
      }
    }

    /* ── 10. D5 — a folder reference navigates, and previews nothing ─────── */

    {
      await openOnTeamTab("i1");
      await shot("i2-before-click-folder");
      const idx = await pillIndex(page, PILLS.folder);
      check(
        "10a-folder-pill-is-openable-as-a-directory",
        (await pills(page))[idx]?.openable === true,
        PILLS.folder,
      );
      const kindAttr = await page.locator("code").nth(idx).getAttribute("data-openable-kind");
      check("10b-folder-pill-carries-the-dir-kind", kindAttr === "dir", `data-openable-kind = ${kindAttr}`);
      await page.locator("code").nth(idx).click();
      const navigated = await waitFor(page, async () => {
        const bc = await page.evaluate(
          () => document.querySelector(".vfl-breadcrumbs")?.textContent?.trim() ?? null,
        );
        return Boolean(bc && /scripts$/.test(bc));
      });
      const after = await panelState(page);
      await shot("i3-after-click-folder");
      check(
        "10c-folder-navigates-and-breadcrumb-ends-with-the-folder-name",
        navigated,
        `breadcrumbs = ${JSON.stringify(after.breadcrumbs)}`,
      );
      check(
        "10d-folder-open-selects-and-previews-nothing",
        after.selectedCount === null || after.selectedCount === 0,
        `panel header says ${JSON.stringify(after.selectedCount)} selected — a directory ` +
          "reference has nothing to preview, the breadcrumb IS the answer (D5)",
      );
    }

    /* ── 11. D6 — the fleet memory root, whichever way it cuts today ─────── */

    {
      await openOnTeamTab("j1");
      const liveRoots = await fetchLiveRootKeys(FORGE_API_URL);
      const memoryIsLive = liveRoots.has("memory");
      console.log(
        `    /api/files/roots reports ${liveRoots.size} live roots ` +
          `(memory ${memoryIsLive ? "IS" : "is NOT"} among them)`,
      );
      await shot("j2-before-click-memory");
      const idx = await pillIndex(page, PILLS.memoryFile);
      check(
        "11a-memory-pill-is-openable-regardless-of-server-state",
        (await pills(page))[idx]?.openable === true,
        `the client's static prefix table offers this pill whether or not ${FORGE_API_URL} has restarted`,
      );
      await page.locator("code").nth(idx).click();
      if (memoryIsLive) {
        const opened = await waitFor(page, async () => {
          const st = await panelState(page);
          return Boolean(st.breadcrumbs && /memory/i.test(st.breadcrumbs));
        }, { timeoutMs: 30000 });
        const after = await panelState(page);
        await shot("j3-after-click-memory-live");
        check(
          "11b-memory-root-is-live-so-the-file-opens",
          opened && after.bodyText.length > 200,
          `/api/files/roots advertises "memory" — breadcrumbs = ${JSON.stringify(after.breadcrumbs)}, ` +
            `${after.bodyText.length} chars of body text`,
        );
      } else {
        const toasted = await waitFor(
          page,
          async () => (await page.evaluate(() => document.body.innerText)).includes("Can't open"),
          { timeoutMs: 15000, stepMs: 200 },
        );
        await shot("j3-after-click-memory-not-live");
        check(
          "11b-memory-root-is-not-live-so-it-toasts-instead-of-a-broken-viewer",
          toasted,
          '/api/files/roots does not advertise "memory" yet — expect the ' +
            '"Can\'t open … yet" toast (resolveRootPath\'s root-not-live branch), ' +
            "never a viewer rendering a 404",
        );
      }
    }

    await browser.close();
    browser = null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (runId && process.env.KEEP_SEED !== "1") {
      // Deletes only the row this run created, by id.
      await pool.query("DELETE FROM runs WHERE id = $1::uuid", [runId]);
      console.log(`removed fixture chat ${runId}`);
    } else if (runId) {
      console.log(`KEEP_SEED=1 — fixture chat ${runId} left in ${dbName}`);
    }
    await pool.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} assertions passed; screenshots in ${OUT_DIR}`,
  );
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof HarnessError) {
    console.error(`\nHARNESS FAULT — the test did not run:\n  ${err.message}`);
    process.exit(2);
  }
  console.error(`\nUNEXPECTED ERROR:\n`, err);
  process.exit(2);
});
