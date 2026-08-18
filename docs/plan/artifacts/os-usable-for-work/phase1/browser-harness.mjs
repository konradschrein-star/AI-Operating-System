#!/usr/bin/env node
/**
 * browser-harness.mjs — the shared authenticated-browser harness for project
 * `os-usable-for-work`. Built once in phase 1 (task B1d), reused by phases 2–6.
 *
 * WHY IT EXISTS. The OS UI is behind GitHub OAuth: forge-control-web/middleware.ts
 * redirects every unauthenticated request to /signin. An agent that points a browser
 * at the OS naively SCREENSHOTS THE LOGIN PAGE, sees no memory notes, and files
 * "the memory surface renders empty" — inventing exactly the class of defect this
 * project exists to remove. So this harness mints a session cookie, and then
 * ASSERTS, after every navigation and before anything is believed, that it is not
 * on /signin. That assertion is a hard error. It is the whole point of the file.
 *
 * ZERO NEW DEPENDENCIES. playwright is resolved at RUNTIME from
 * /opt/hermes-workspace/node_modules and chromium from /root/.cache/ms-playwright.
 * Nothing is added to any package.json or pnpm-lock.yaml in this repo, by design:
 * phases 2–6 run under gates that diff the lockfile.
 *
 * Recipe, invocation contract and failure modes: browser-harness.md, next to this file.
 *
 * OUTPUT CONTRACT
 *   stderr — human-readable progress, one line per step.
 *   stdout — exactly one JSON object, the machine-readable result. Parse that.
 *   exit 0 — navigation succeeded AND the /signin assertion passed.
 *   exit 1 — a usage error, a mint failure, a navigation failure, or a hard error.
 *   exit 2 — THE AUTH WALL. Reserved: the harness reached /signin. Distinct on
 *            purpose, so a caller can tell "the cookie is wrong" from "the page broke".
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// ── constants that encode facts about this machine, not preferences ──────────
const PLAYWRIGHT_ROOT = "/opt/hermes-workspace/node_modules";
const CHROMIUM_CACHE = "/root/.cache/ms-playwright";
const DEFAULT_ENV_FILE = "/opt/forge-ai-os/forge-control-web/.env.local";
const SELF_DIR = path.dirname(new URL(import.meta.url).pathname);

/**
 * THE TWO SALTS. auth.js v5 uses the session cookie's NAME as the JWE salt, and the
 * name depends on the RUNNING SERVER's AUTH_URL, not on the port you dial:
 *   http  AUTH_URL → "authjs.session-token"           , secure: false
 *   https AUTH_URL → "__Secure-authjs.session-token"  , secure: true
 * Getting it wrong is a 307 to /signin that looks exactly like an expired token, and
 * it has already cost this fleet two rounds. See 02-architecture.md §0.2.
 */
const SALT_PLAIN = "authjs.session-token";
const SALT_SECURE = "__Secure-authjs.session-token";

/**
 * Ports served by a next-server whose AUTH_URL is the https production host, even
 * though you address them over plain http from this machine. 7701 is the live UI.
 * A throwaway `next start` you launched yourself with AUTH_URL=http://… is NOT here.
 */
const LIVE_HTTPS_PORTS = new Set(["7701"]);

const USAGE = `
browser-harness.mjs — drive the authenticated OS UI, prove you are past /signin.

  node browser-harness.mjs --base <url> --path <route> [options]

Required
  --base <url>          origin to drive, e.g. http://127.0.0.1:7781
  --path <route>        route to open, e.g. /desktop  (default: /desktop)

Screenshot / evidence
  --shot <file>         write a PNG here; parent directories are created.
                        Konrad only sees shots under /opt/ai-os/uploads/$FORGE_RUN_ID/
                        and only after you Read the file back. See browser-harness.md §6.
  --full-page           full-page screenshot instead of viewport
  --dump-html <file>    write the rendered DOM (document.documentElement.outerHTML)
  --eval <js>           evaluate a function BODY in the page and put its (JSON-
                        serialisable) return value on stdout under "eval".
                        e.g. --eval 'return document.fonts.check("1em Inter")'
  --eval-file <file>    same, read the body from a file (for anything with quotes)

Auth
  --secret-file <file>  where AUTH_SECRET is read from (default ${DEFAULT_ENV_FILE})
                        READ ONLY. This harness never writes to the live checkout.
                        NOT called --env-file: node itself claims that flag even AFTER
                        the script path, and exits 9 before this script ever runs.
  --salt auto|plain|secure|<literal>
                        cookie name AND JWE salt. auto (default) picks secure for an
                        https --base or a port in {${[...LIVE_HTTPS_PORTS].join(",")}}, plain otherwise.
  --max-age <seconds>   token lifetime (default 14400)
  --cookie-out <file>   also write the minted token here, for FORGE_SESSION_COOKIE
  --web-dir <path>      forge-control-web to borrow next-auth/jwt from. Only needed when
                        running this file from outside the repo (see browser-harness.md §7).

Network
  --allow-external      DO NOT block third-party origins. Default is to block them, because
                        this VPS cannot reach fonts.googleapis.com and the stalled stylesheet
                        hangs DOMContentLoaded for the whole navigation timeout. Blocked
                        requests are listed in the JSON as "blockedExternal" — the harness
                        never hides what it withheld. See browser-harness.md §5, failure 4.

Timing / viewport
  --wait-until <state>  commit | domcontentloaded | load | networkidle (default domcontentloaded)
  --wait-selector <sel> wait for this selector after load (in addition to the wall check)
  --settle <ms>         extra wait after load before the screenshot (default 1200)
  --timeout <ms>        per-navigation timeout (default 45000)
  --viewport <WxH>      default 1600x1000
  --keep-going          do not exit on the FIRST failed selector wait; the /signin
                        assertion is NEVER downgraded by this flag

Diagnostics
  --quiet               suppress the stderr progress lines (stdout JSON is unchanged)
  --help                this text
`;

// ── argv ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = new Set(["--full-page", "--keep-going", "--quiet", "--allow-external", "--help", "-h"]);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") && a !== "-h") {
      out._.push(a);
      continue;
    }
    const key = a.replace(/^--?/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (flags.has(a)) {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`option ${a} needs a value`);
    out[key] = value;
  }
  return out;
}

let QUIET = false;
const say = (msg) => {
  if (!QUIET) process.stderr.write(`${msg}\n`);
};

/**
 * The single stdout JSON object promised by the invocation contract (browser-harness.md §4).
 * It is emitted EXACTLY ONCE, on every path including an early failure — a run that dies
 * before the browser launches must still be diagnosable by a caller parsing stdout.
 */
const RESULT = {
  ok: false,
  base: null,
  path: null,
  url: null,
  status: null,
  title: null,
  salt: null,
  secure: null,
  shot: null,
  html: null,
  eval: undefined,
  error: null,
  consoleErrors: [],
  failedRequests: [],
  blockedExternal: [],
  startedAt: new Date().toISOString(),
  finishedAt: null,
};
let EMITTED = false;
function emit() {
  if (EMITTED) return;
  EMITTED = true;
  RESULT.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(RESULT, null, 2)}\n`);
}

/** Every failure path in this file goes through here: a message, never a silent fallback. */
class HarnessError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
  }
}

// ── step 1: AUTH_SECRET, read-only, from the live checkout ──────────────────
function readAuthSecret(envFile) {
  if (!fs.existsSync(envFile)) {
    throw new HarnessError(
      `AUTH_SECRET source not found: ${envFile}\n` +
        `  This file is READ, never written. If the live checkout moved, pass --secret-file.`,
    );
  }
  const text = fs.readFileSync(envFile, "utf8");
  const line = text.split(/\r?\n/).find((l) => /^\s*(export\s+)?AUTH_SECRET\s*=/.test(l));
  if (!line) {
    throw new HarnessError(
      `no AUTH_SECRET line in ${envFile}\n` +
        `  Looked for /^\\s*(export\\s+)?AUTH_SECRET\\s*=/ over ${text.split(/\r?\n/).length} lines.`,
    );
  }
  const raw = line.slice(line.indexOf("=") + 1).trim();
  const secret = raw.replace(/^(['"])(.*)\1$/, "$2");
  if (!secret) {
    throw new HarnessError(`AUTH_SECRET in ${envFile} is present but empty — refusing to mint on it.`);
  }
  return secret;
}

// ── step 2: which salt, and why ─────────────────────────────────────────────
function resolveSalt(baseUrl, requested) {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const auto = url.protocol === "https:" || LIVE_HTTPS_PORTS.has(port) ? SALT_SECURE : SALT_PLAIN;
  const choice = !requested || requested === "auto" ? auto : requested;
  const salt = choice === "plain" ? SALT_PLAIN : choice === "secure" ? SALT_SECURE : choice;
  if (salt !== SALT_PLAIN && salt !== SALT_SECURE) {
    say(
      `!! --salt ${salt} is neither of the two known salts. Proceeding because you asked ` +
        `explicitly; a wrong salt is a 307 to /signin that looks like an expired token.`,
    );
  }
  return {
    salt,
    // A __Secure- prefixed name with secure:false is rejected by CDP outright:
    //   Protocol error (Storage.setCookies): Invalid cookie fields
    secure: salt.startsWith("__Secure-"),
    auto: auto === salt && (!requested || requested === "auto"),
    reason:
      url.protocol === "https:"
        ? "https --base → the server's AUTH_URL is https"
        : LIVE_HTTPS_PORTS.has(port)
          ? `port ${port} is a known live next-server whose AUTH_URL is https`
          : "plain http --base → a throwaway next start with an http AUTH_URL",
  };
}

/**
 * Locate forge-control-web/package.json, so next-auth/jwt is borrowed from the very
 * package whose server will READ the cookie — a JWE minted by another next-auth build
 * is not guaranteed to decode.
 *
 * Three candidates, in order, because the cross-lane recipe in browser-harness.md §7
 * deliberately runs this file from /tmp, where the script-relative path does not exist:
 *   1. --web-dir, if given
 *   2. script-relative (the in-repo layout: docs/plan/artifacts/<proj>/phase1/)
 *   3. walking up from cwd — the /tmp case, where cwd is the worktree
 */
function locateWebPackage(explicit) {
  const tried = [];
  const check = (dir) => {
    const pkg = path.join(dir, "package.json");
    tried.push(pkg);
    return fs.existsSync(pkg) ? pkg : null;
  };
  if (explicit) {
    const hit = check(path.resolve(explicit));
    if (hit) return hit;
    throw new HarnessError(`--web-dir ${explicit} has no package.json (looked at ${tried.join(", ")})`);
  }
  const relative = check(path.resolve(SELF_DIR, "../../../../../forge-control-web"));
  if (relative) return relative;
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const hit = check(path.join(dir, "forge-control-web"));
    if (hit) return hit;
    if (dir === path.dirname(dir)) break;
  }
  throw new HarnessError(
    `cannot locate forge-control-web to borrow next-auth from.\n` +
      `  Tried, in order:\n    ${tried.join("\n    ")}\n` +
      `  Run this from inside the worktree, or pass --web-dir <path to forge-control-web>.`,
  );
}

// ── step 3: mint the cookie with the app's OWN next-auth ────────────────────
async function mintCookie({ secret, salt, maxAge, webDir }) {
  const WEB_PKG = locateWebPackage(webDir);
  const req = createRequire(WEB_PKG);
  let jwtPath;
  try {
    jwtPath = req.resolve("next-auth/jwt");
  } catch (err) {
    throw new HarnessError(
      `next-auth/jwt is not installed under ${path.dirname(WEB_PKG)}: ${err.message}\n` +
        `  Fix: cd forge-control-web && pnpm install --frozen-lockfile --prod=false\n` +
        `  (NODE_ENV=production makes a bare --frozen-lockfile skip devDependencies, quietly, exit 0.)`,
    );
  }
  const { encode } = await import(pathToFileURL(jwtPath).href);
  if (typeof encode !== "function") {
    throw new HarnessError(`next-auth/jwt resolved to ${jwtPath} but exports no encode()`);
  }
  const token = await encode({
    token: { name: "os-usable", email: "check@localhost", sub: "check" },
    secret,
    salt,
    maxAge,
  });
  if (!token || typeof token !== "string") {
    throw new HarnessError(`encode() returned ${typeof token}, expected a string JWE`);
  }
  return token;
}

// ── step 4: playwright + chromium, both resolved at runtime ─────────────────
async function loadPlaywright() {
  const entry = path.join(PLAYWRIGHT_ROOT, "playwright");
  if (!fs.existsSync(entry)) {
    throw new HarnessError(
      `playwright not found at ${entry}\n` +
        `  It is resolved at RUNTIME from hermes' node_modules on purpose: this repo adds no\n` +
        `  browser dependency. Do NOT "fix" this by running pnpm add playwright.`,
    );
  }
  const req = createRequire(path.join(PLAYWRIGHT_ROOT, "index.js"));
  const { chromium } = req("playwright");
  return chromium;
}

function chromeExecutable() {
  if (!fs.existsSync(CHROMIUM_CACHE)) {
    throw new HarnessError(`no playwright browser cache at ${CHROMIUM_CACHE}`);
  }
  const candidates = fs
    .readdirSync(CHROMIUM_CACHE)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(CHROMIUM_CACHE, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(CHROMIUM_CACHE, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (candidates.length === 0) {
    throw new HarnessError(
      `no chromium binary under ${CHROMIUM_CACHE} (looked in ${fs
        .readdirSync(CHROMIUM_CACHE)
        .join(", ")})`,
    );
  }
  return candidates[0];
}

// ── step 5: is anything even listening? A connection-refused must not be read
//    as "the surface is dead". ────────────────────────────────────────────────
function probePort(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/**
 * THE ASSERTION THAT IS THE WHOLE POINT.
 * Called after EVERY navigation, before anything on the page is believed.
 * It throws. It never warns, and no flag downgrades it.
 */
function assertPastAuthWall(url, ctx = {}) {
  if (!/\/signin\b/.test(url)) return;
  const salt = ctx.salt ? `"${ctx.salt}"` : "(unknown)";
  throw new HarnessError(
    `auth wall: landed on ${url}. FIRST SUSPECT IS THE SALT, not the secret: ` +
      `an https AUTH_URL (production, and :7701) needs salt AND cookie name ` +
      `"${SALT_SECURE}" with secure:true; a plain http throwaway harness needs ` +
      `"${SALT_PLAIN}" with secure:false. A wrong salt is a 307 that looks exactly like an ` +
      `expired token. Every screenshot after this point would be of the login page.\n` +
      `  this run used salt ${salt} (secure:${ctx.secure}) against ${ctx.base}\n` +
      `  second suspect: AUTH_SECRET drift between ${ctx.envFile} and the running server\n` +
      `  third suspect:  maxAge expired (this run: ${ctx.maxAge}s)`,
    2,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    process.stdout.write(USAGE);
    EMITTED = true; // --help prints the usage text and nothing else; no result to report
    return 0;
  }
  QUIET = Boolean(args.quiet);

  const base = args.base;
  if (!base) throw new HarnessError(`--base is required.\n${USAGE}`);
  const route = args.path ?? "/desktop";
  if (!route.startsWith("/")) throw new HarnessError(`--path must start with "/", got ${route}`);
  const maxAge = Number(args.maxAge ?? 14400);
  if (!Number.isFinite(maxAge) || maxAge <= 0) throw new HarnessError(`--max-age must be a positive number`);
  const settle = Number(args.settle ?? 1200);
  const timeout = Number(args.timeout ?? 45000);
  const [vw, vh] = String(args.viewport ?? "1600x1000").split("x").map(Number);
  if (!Number.isFinite(vw) || !Number.isFinite(vh)) throw new HarnessError(`--viewport must be WxH`);
  const envFile = args.secretFile ?? DEFAULT_ENV_FILE;

  const baseUrl = new URL(base);
  const port = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");

  RESULT.base = base;
  RESULT.path = route;

  const listening = await probePort(baseUrl.hostname, port);
  if (!listening) {
    throw new HarnessError(
      `nothing is listening on ${baseUrl.hostname}:${port}\n` +
        `  A dead port is NOT a dead surface. Start the server first — browser-harness.md §2\n` +
        `  has the exact build + next start commands for a throwaway port.`,
    );
  }
  say(`· ${baseUrl.hostname}:${port} is listening`);

  const secret = readAuthSecret(envFile);
  say(`· AUTH_SECRET read from ${envFile} (${secret.length} chars, never logged)`);

  const { salt, secure, auto, reason } = resolveSalt(base, args.salt);
  RESULT.salt = salt;
  RESULT.secure = secure;
  say(`· salt ${salt} (secure:${secure})${auto ? " [auto]" : " [explicit]"} — ${reason}`);

  const token = await mintCookie({ secret, salt, maxAge, webDir: args.webDir });
  say(`· minted session cookie, ${token.length} chars, maxAge ${maxAge}s`);
  if (args.cookieOut) {
    fs.mkdirSync(path.dirname(path.resolve(args.cookieOut)), { recursive: true });
    fs.writeFileSync(args.cookieOut, token, { mode: 0o600 });
    say(`· cookie written to ${args.cookieOut} (mode 600) for FORGE_SESSION_COOKIE`);
  }

  const chromium = await loadPlaywright();
  const executablePath = chromeExecutable();
  say(`· chromium ${executablePath}`);

  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: vw, height: vh } });
    await context.addCookies([
      {
        name: salt, // in auth.js v5 the cookie NAME and the JWE salt are the same string
        value: token,
        domain: baseUrl.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure,
        expires: Math.floor(Date.now() / 1000) + maxAge,
      },
    ]);
    const page = await context.newPage();

    /**
     * BLOCK THIRD-PARTY ORIGINS BY DEFAULT — measured, not assumed, and INTERMITTENT.
     * The app links three Google Fonts stylesheets (Inter, JetBrains Mono, Material
     * Symbols). `fonts.googleapis.com` has both an A and a AAAA record, and this host
     * has NO working IPv6 egress. Which record the resolver hands back decides the run:
     *   AAAA first (2a00:1450:…) → connect stalls, curl gives up after 20s
     *   A first    (209.85.233.95) → HTTP 200 in 0.22s
     * Measured on 2026-08-18: 2 of the first 3 navigations stalled and timed out at 45s;
     * 6 later ones loaded in ~1.4s. The variable is the resolver, not the page.
     * A render-blocking stylesheet that never resolves means DOMContentLoaded never
     * fires, so `page.goto` times out and the harness reports a LIVE surface as dead —
     * the exact false negative this project exists to eliminate. An intermittent version
     * of that is worse than a reliable one, because it teaches you to retry instead of
     * to look. Blocking is therefore the default: browser evidence must not depend on
     * which DNS answer arrived. Everything blocked is reported, so a reader can never
     * mistake what the harness withheld for something the page did not ask for.
     *
     * CONSEQUENCE FOR PHASE 2 (A5, "weird font"): with fonts blocked, this UI degrades
     * to fallback text AND its Material Symbols ligatures render as literal words
     * ("settings SETTINGS", "search search everything", "light_mode") — see
     * harness-proof.png. That is an artefact of THIS FLAG, not Konrad's defect. Any A5
     * measurement must run --allow-external and assert document.fonts.check() plus the
     * request status, never judge a screenshot by eye.
     */
    if (!args.allowExternal) {
      const baseOrigin = baseUrl.origin;
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(baseOrigin) || url.startsWith("data:") || url.startsWith("blob:")) {
          return route.continue();
        }
        RESULT.blockedExternal.push(url.slice(0, 200));
        return route.abort();
      });
      say(`· blocking third-party origins (fonts.googleapis.com hangs on this host; --allow-external to disable)`);
    } else {
      say(`!! --allow-external: third-party requests will be attempted. If this run times out,`);
      say(`!! that is the IPv6 font stall, not a dead surface. See browser-harness.md §5 failure 4.`);
    }

    page.on("console", (m) => {
      if (m.type() === "error") RESULT.consoleErrors.push(m.text().slice(0, 500));
    });
    page.on("requestfailed", (r) =>
      RESULT.failedRequests.push({ url: r.url().slice(0, 300), error: r.failure()?.errorText ?? "unknown" }),
    );

    const target = new URL(route, base).href;
    const waitUntil = args.waitUntil ?? "domcontentloaded";
    if (!["commit", "domcontentloaded", "load", "networkidle"].includes(waitUntil)) {
      throw new HarnessError(`--wait-until must be commit|domcontentloaded|load|networkidle, got ${waitUntil}`);
    }
    say(`· GET ${target} (waitUntil ${waitUntil})`);
    const response = await page.goto(target, { waitUntil, timeout });
    RESULT.status = response ? response.status() : null;
    RESULT.url = page.url();

    // ── THE ASSERTION. First thing after the navigation, before anything is believed.
    assertPastAuthWall(RESULT.url, { salt, secure, base, envFile, maxAge });
    say(`· past the auth wall: ${RESULT.url} (HTTP ${RESULT.status})`);

    if (args.waitSelector) {
      try {
        await page.waitForSelector(args.waitSelector, { timeout });
        say(`· selector present: ${args.waitSelector}`);
      } catch (err) {
        const msg = `selector never appeared: ${args.waitSelector} (${err.message.split("\n")[0]})`;
        if (!args.keepGoing) throw new HarnessError(msg);
        say(`!! ${msg} — continuing because --keep-going`);
        RESULT.selectorMissing = args.waitSelector;
      }
    }

    if (settle > 0) await page.waitForTimeout(settle);

    // A client-side redirect can land on /signin AFTER the settle. Re-assert.
    RESULT.url = page.url();
    assertPastAuthWall(RESULT.url, { salt, secure, base, envFile, maxAge });
    RESULT.title = await page.title();

    if (args.shot) {
      const shot = path.resolve(args.shot);
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot, fullPage: Boolean(args.fullPage) });
      RESULT.shot = shot;
      say(`· screenshot → ${shot}`);
    }
    if (args.dumpHtml) {
      const out = path.resolve(args.dumpHtml);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, await page.evaluate(() => document.documentElement.outerHTML));
      RESULT.html = out;
      say(`· DOM → ${out}`);
    }
    const body = args.evalFile ? fs.readFileSync(args.evalFile, "utf8") : args.eval;
    if (body) {
      RESULT.eval = await page.evaluate(new Function(body));
      say(`· eval returned ${JSON.stringify(RESULT.eval)?.slice(0, 200) ?? "undefined"}`);
    }

    RESULT.ok = true;
    return 0;
  } finally {
    await browser.close();
  }
}

main()
  .then((code) => {
    emit();
    process.exit(code);
  })
  .catch((err) => {
    // The JSON is emitted on the failure path too, so a caller parsing stdout can
    // diagnose a run that died before the browser ever launched.
    RESULT.error = err.message;
    emit();
    process.stderr.write(`\nFAILED — ${err.message}\n`);
    if (!(err instanceof HarnessError) && err.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(err instanceof HarnessError ? err.code : 1);
  });
