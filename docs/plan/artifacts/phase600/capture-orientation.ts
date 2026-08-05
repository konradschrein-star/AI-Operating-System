/**
 * capture-orientation.ts — both-theme evidence for U22/U24, rendered OFFLINE.
 *
 * ── Why this and not a browser against the app ───────────────────────────
 * Round 601B's `capture-nav.cjs` drives the real surface, which needs the
 * worktree's Next server AND an API pointed at the live database. A build task
 * has no business doing that (worktree-only policy), and the orientation strip
 * makes it worse: its interesting states are the DEGRADED ones — team panel
 * closed, request failed, node not in the tree — which a live capture can only
 * reach by breaking something live.
 *
 * So the components render themselves to static HTML here, against the real
 * `app/theme.css` and `app/globals.css`, and chromium photographs the result in
 * both palettes. Every state gets a picture, including the five that only exist
 * when something has gone wrong. No server, no database, no pm2.
 *
 * That is what `OrientationStripView` was split out for: the half with the
 * react-query hook in it cannot render without a live QueryClient; the half
 * that draws pixels takes `PlanFacts` as a prop and renders anywhere.
 *
 * ── No JSX, and no bare imports of npm packages, on purpose ──────────────
 * This file lives under `docs/`, which has no `node_modules` above it — a bare
 * `import ... from "react"` here does not resolve, and neither does the JSX
 * runtime the automatic transform would emit. Both are reached through
 * `createRequire` anchored at forge-control-web's package.json, and elements
 * are built with `React.createElement`. The components themselves import
 * normally; they live inside the app tree where resolution works.
 *
 * Run (from forge-control-web):
 *   ../forge-control/node_modules/.bin/tsx ../docs/plan/artifacts/phase600/capture-orientation.ts
 *
 * Writes, next to this file:
 *   capture-orientation.html          the rendered states, one page
 *   phase600-orientation-<theme>.png  the strip, all seven states
 *   phase600-digest-<theme>.png       the story-so-far block, collapsed + open
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunDetail, ThreadEntry } from "../../../../forge-control-web/app/api.ts";
import type { PlanFacts } from "../../../../forge-control-web/app/desktop/chat/OrientationStrip.tsx";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..", "..", "..", "forge-control-web");

const requireFromWeb = createRequire(join(WEB, "package.json"));
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- resolved by path, typed below */
const React = requireFromWeb("react") as typeof import("react");
const { renderToStaticMarkup } = requireFromWeb("react-dom/server") as {
  renderToStaticMarkup: (node: unknown) => string;
};
const { chromium } = requireFromWeb("/opt/hermes-workspace/node_modules/playwright") as {
  chromium: {
    launch: (o: { executablePath: string }) => Promise<{
      newContext: (o: { viewport: { width: number; height: number } }) => Promise<{
        newPage: () => Promise<Page>;
      }>;
      close: () => Promise<void>;
    }>;
  };
};

interface Page {
  goto: (url: string) => Promise<unknown>;
  evaluate: <T>(fn: (arg: T) => unknown, arg?: T) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  locator: (sel: string) => { screenshot: (o: { path: string }) => Promise<unknown> };
}

const h = React.createElement;

/* The app's own tsconfig sets `jsx: "preserve"` (Next compiles it), so tsx
 * falls back to the CLASSIC transform for the component files — their compiled
 * output calls a free variable `React` that nothing imports. Putting React on
 * the global before those modules are LOADED is what makes them runnable
 * outside Next. Hence the dynamic imports in `main()`: static ones are hoisted
 * above this line and would execute first. */
(globalThis as unknown as { React: unknown }).React = React;

/* ── Fixtures ─────────────────────────────────────────────────────────────
 * The session cases use the REAL 285-entry architect capture, so the digest's
 * numbers in the screenshots are the numbers `check-story-digest.ts` asserts.
 */

const fixture = JSON.parse(
  readFileSync(join(HERE, "fixtures", "run-3853c154-chat.json"), "utf8"),
) as { run: RunDetail };
const REAL = fixture.run;
const SUB_ID = "toolu_014raMUrJcAiXV61BerokrjN";

const TASK: PlanFacts["task"] = {
  title: "603 · OrientationStrip + story-so-far digest in the drilled view",
  round: 603,
  status: "running",
  role: "builder",
};

const READY: PlanFacts = { task: TASK, plan: { phase: 600, next: 700 }, degraded: null };
const facts = (degraded: NonNullable<PlanFacts["degraded"]>): PlanFacts => ({
  task: null,
  plan: null,
  degraded,
});

const ARCHITECT = {
  role: "architect",
  model: "claude-fable-5",
  description: REAL.title,
};

/** A live tool_call activity, in the shape the executor stamps. */
const RUNNING_META: Record<string, unknown> = {
  current_activity: {
    kind: "tool_call",
    tool: "Bash",
    text: null,
    ts: "2026-08-06T09:14:02.113Z",
  },
};

async function main(): Promise<void> {
  /* Loaded here, not at the top, so `globalThis.React` is already set — see
   * the note above. */
  const { OrientationStripView } = await import(
    "../../../../forge-control-web/app/desktop/chat/OrientationStrip.tsx"
  );
  const { StorySoFar } = await import(
    "../../../../forge-control-web/app/desktop/chat/StorySoFar.tsx"
  );
  const { subagentEntries } = await import(
    "../../../../forge-control-web/app/desktop/chat/subagent-slice.ts"
  );

  const SLICE: ThreadEntry[] = subagentEntries(REAL.thread, SUB_ID);

  const cases: Array<{ title: string; node: unknown }> = [
    {
      title: "session · running · task from the team tree · phase derived from round 603",
      node: h(OrientationStripView, {
        isSubagent: false,
        identity: { role: "builder", model: "claude-sonnet-5", description: REAL.title },
        metadata: RUNNING_META,
        subagent: null,
        settled: false,
        facts: READY,
      }),
    },
    {
      title: "session · SETTLED — the same activity reads 'ended:', never 'currently:'",
      node: h(OrientationStripView, {
        isSubagent: false,
        identity: ARCHITECT,
        metadata: REAL.metadata,
        subagent: null,
        settled: true,
        facts: READY,
      }),
    },
    {
      title: "sub-agent · its OWN latest_activity, and no task (sub-agents carry none)",
      node: h(OrientationStripView, {
        isSubagent: true,
        identity: { role: "Explore", model: "claude-haiku-4-5-20251001", description: "Recon chat Bash block rendering" },
        metadata: REAL.metadata,
        subagent: {
          tool_use_id: SUB_ID,
          role: "Explore",
          model: "claude-haiku-4-5-20251001",
          description: "Recon chat Bash block rendering",
          status: "done",
          started_at: null,
          ended_at: null,
          updated_at: null,
          event_count: SLICE.length,
          usage: null,
          latest_activity: {
            kind: "tool_result",
            tool: "Grep",
            text: "12 matches in app/desktop/chat",
            ts: "2026-08-05T06:58:41.002Z",
          },
        },
        settled: true,
        facts: facts("no-task"),
      }),
    },
    {
      title: "DEGRADED · team panel closed — nothing is polling, so nothing is claimed",
      node: h(OrientationStripView, {
        isSubagent: false,
        identity: ARCHITECT,
        metadata: REAL.metadata,
        subagent: null,
        settled: true,
        facts: facts("team-not-polling"),
      }),
    },
    {
      title: "DEGRADED · team request failed",
      node: h(OrientationStripView, {
        isSubagent: false,
        identity: ARCHITECT,
        metadata: RUNNING_META,
        subagent: null,
        settled: false,
        facts: facts("team-error"),
      }),
    },
    {
      title: "DEGRADED · the live tree does not contain this node",
      node: h(OrientationStripView, {
        isSubagent: false,
        identity: ARCHITECT,
        metadata: RUNNING_META,
        subagent: null,
        settled: false,
        facts: facts("node-absent"),
      }),
    },
    {
      title: "DEGRADED · no identity recorded at all, and no activity stamped",
      node: h(OrientationStripView, {
        isSubagent: false,
        identity: { role: null, model: null, description: null },
        metadata: {},
        subagent: null,
        settled: false,
        facts: facts("team-loading"),
      }),
    },
  ];

  const digests: Array<{ title: string; node: unknown }> = [
    {
      title: "collapsed — the default, and the only state the app opens in",
      node: h(StorySoFar, { run: REAL, thread: REAL.thread, scope: "session" }),
    },
    {
      title: "expanded — 285 entries, 136 tool calls, 3 tool errors, 2 sub-agents",
      node: h(StorySoFar, {
        run: REAL,
        thread: REAL.thread,
        scope: "session",
        defaultOpen: true,
      }),
    },
    {
      title: `expanded, sub-agent scope — the scout's own ${SLICE.length}-entry slice, no borrowed clock`,
      node: h(StorySoFar, {
        run: { ...REAL, title: "Recon chat Bash block rendering", status: "completed" },
        thread: SLICE,
        scope: "subagent",
        defaultOpen: true,
      }),
    },
  ];

  /* ── Page ─────────────────────────────────────────────────────────────────── */

  function section(id: string, items: Array<{ title: string; node: unknown }>): string {
    const body = items
      .map(
        (c) =>
          `<div class="case"><div class="caption">${c.title
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")}</div>${renderToStaticMarkup(c.node)}</div>`,
      )
      .join("\n");
    return `<div id="${id}" class="shot">${body}</div>`;
  }

  const html = `<!doctype html>
  <html data-theme="dark">
  <head>
  <meta charset="utf-8">
  <style>${readFileSync(join(WEB, "app", "globals.css"), "utf8")}</style>
  <style>${readFileSync(join(WEB, "app", "theme.css"), "utf8")}</style>
  <style>
    body { background: var(--fg-bgBody); color: var(--fg-text); padding: 0; }
    .shot { width: 1000px; background: var(--fg-bgCard); }
    .case { border-bottom: 1px solid var(--fg-border); }
    .caption {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px; letter-spacing: 0.06em;
      color: var(--fg-textFaint); padding: 10px 14px 4px;
    }
  </style>
  </head>
  <body>
  ${section("orientation", cases)}
  ${section("digest", digests)}
  </body>
  </html>`;

  const htmlPath = join(HERE, "capture-orientation.html");
  writeFileSync(htmlPath, html);
  console.log(`wrote ${htmlPath} (${html.length} bytes)`);
  await shoot(htmlPath);
}

function resolveChromium(): string {
  const fs = requireFromWeb("node:fs") as typeof import("node:fs");
  const path = requireFromWeb("node:path") as typeof import("node:path");
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/root/.cache/ms-playwright";
  const found = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-") || d.startsWith("chromium-"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(cache, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (found.length === 0) throw new Error(`no chromium binary under ${cache}`);
  return found[0];
}

/* ── Shoot ────────────────────────────────────────────────────────────────── */

async function shoot(htmlPath: string): Promise<void> {
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1040, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(`file://${htmlPath}`);

  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t: string) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(200);
    for (const [id, name] of [
      ["#orientation", "orientation"],
      ["#digest", "digest"],
    ] as const) {
      const file = join(HERE, `phase600-${name}-${theme}.png`);
      await page.locator(id).screenshot({ path: file });
      console.log(`  shot phase600-${name}-${theme}.png`);
    }
  }

  await browser.close();
  console.log("done");
}

/* An IIFE rather than top-level await: tsx compiles this file to CJS (nothing
 * above `docs/` declares `"type": "module"`), and CJS has no top-level await. */
void main();
