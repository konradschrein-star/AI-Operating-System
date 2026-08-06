/**
 * capture-plandoc.ts — the plan-doc shell, both themes, rendered OFFLINE.
 *
 * WHY THIS ONE CASE IS NOT SHOT IN THE APP. `PlanDocView` is reachable only when
 * the top of the nav stack is a `plandoc` frame, and NOTHING PUSHES ONE: the
 * Kanban that will is phase 700's, together with the `GET /api/chat/:id/plan/doc`
 * endpoint the view is waiting for (PlanDocView.tsx:11-14, round 601B README §6
 * deviation 3). The stack lives in `useState` inside `ChatSurface` with no
 * global handle, so a browser protocol cannot push a frame either — and an
 * evidence round may not add one, because that is application code.
 *
 * So the shell renders itself to static HTML against the real `theme.css` and
 * `globals.css` and chromium photographs both palettes — exactly the method
 * round 603 used for the strip's degraded states (`capture-orientation.ts`), and
 * for the same reason: the alternative is no both-theme evidence at all for a
 * surface the brief names.
 *
 * The nav stack handed to it is a REAL one — manager → worker → plandoc — built
 * with the shipped `crumbs()` reducer, so the lineage line in the picture is the
 * one the app will draw when phase 700 pushes the frame.
 *
 * No JSX and no bare npm imports: this file lives under `docs/`, which has no
 * `node_modules` above it. Same `createRequire` + `React.createElement` shape as
 * capture-orientation.ts.
 *
 * Run (from forge-control-web):
 *   ../forge-control/node_modules/.bin/tsx ../docs/plan/artifacts/phase600/capture-plandoc.ts
 *
 * Writes, next to this file:
 *   capture-plandoc.html
 *   phase600-604-plandoc-<theme>.png
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NavStack } from "../../../../forge-control-web/app/desktop/chat/nav-stack.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..", "..", "..", "forge-control-web");

const requireFromWeb = createRequire(join(WEB, "package.json"));
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
(globalThis as unknown as { React: unknown }).React = React;

/** The real fixture this round walked: chat 11dd264b → worker 58096061. */
const STACK: NavStack = [
  { kind: "agent", runId: "58096061-803e-43c5-827a-e618d2a9c33e" },
  { kind: "plandoc", name: "13-ui-v3-architecture.md" },
];

async function main(): Promise<void> {
  const { PlanDocView } = await import(
    "../../../../forge-control-web/app/desktop/chat/PlanDocView.tsx"
  );

  const cases: Array<{ title: string; node: unknown }> = [
    {
      title:
        "depth 2 · manager chat › session 58096061 › 13-ui-v3-architecture.md — the shell, with the lineage the reducer builds",
      node: h(PlanDocView, {
        name: "13-ui-v3-architecture.md",
        stack: STACK,
        onBack: () => {},
        backLabel: "← session 58096061",
      }),
    },
    {
      title: "depth 1 · pushed straight from the manager chat — back returns to the chat",
      node: h(PlanDocView, {
        name: "14-ui-v3-quality.md",
        stack: [{ kind: "plandoc", name: "14-ui-v3-quality.md" }] as NavStack,
        onBack: () => {},
        backLabel: "← manager chat",
      }),
    },
  ];

  const body = cases
    .map(
      (c) =>
        `<div class="case"><div class="caption">${c.title
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</div><div class="frame">${renderToStaticMarkup(c.node)}</div></div>`,
    )
    .join("\n");

  const html = `<!doctype html>
  <html data-theme="dark">
  <head>
  <meta charset="utf-8">
  <style>${readFileSync(join(WEB, "app", "globals.css"), "utf8")}</style>
  <style>${readFileSync(join(WEB, "app", "theme.css"), "utf8")}</style>
  <style>
    body { background: var(--fg-bgBody); color: var(--fg-text); padding: 0; margin: 0; }
    #plandoc { width: 1000px; background: var(--fg-bgCard); }
    .case { border-bottom: 1px solid var(--fg-border); }
    .frame { height: 190px; display: flex; }
    .caption {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 10px; letter-spacing: 0.06em;
      color: var(--fg-textFaint); padding: 10px 14px 4px;
    }
  </style>
  </head>
  <body><div id="plandoc">${body}</div></body>
  </html>`;

  const htmlPath = join(HERE, "capture-plandoc.html");
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

async function shoot(htmlPath: string): Promise<void> {
  const browser = await chromium.launch({ executablePath: resolveChromium() });
  const ctx = await browser.newContext({ viewport: { width: 1040, height: 600 } });
  const page = await ctx.newPage();
  await page.goto(`file://${htmlPath}`);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t: string) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(200);
    const file = join(HERE, `phase600-604-plandoc-${theme}.png`);
    await page.locator("#plandoc").screenshot({ path: file });
    console.log(`  shot phase600-604-plandoc-${theme}.png`);
  }
  await browser.close();
  console.log("done");
  /* `browser.close()` leaves the context's own handle open in this minimal
   * typing, and tsx then sits on a live handle forever. capture-600.cjs shells
   * out to this file and waits for it, so a process that never exits is a hang,
   * not an inconvenience. Exit explicitly, after the PNGs are on disk. */
  process.exit(0);
}

void main();
