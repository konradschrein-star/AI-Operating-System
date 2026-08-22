/**
 * /api/terminal — a real shell on this box, beside the chat.
 *
 * ── WHY TMUX AND NOT node-pty ────────────────────────────────────────────────
 * The obvious build is node-pty + xterm.js over a WebSocket. tmux wins here for
 * one reason that matters more than fidelity: THE SESSION OUTLIVES THE TAB.
 * Konrad's stated use is "run Claude Code agents directly on the VPS" — those
 * run for minutes to hours. With a pty owned by the browser connection, closing
 * the tab or losing wifi on a train kills the agent mid-run. With tmux the
 * process is owned by the server, the browser is only a viewport, and a reload
 * reattaches to exactly what was there.
 *
 * It also needs no native module. node-pty compiles against the Node ABI, and
 * this box has already had one incident where a production dependency tree went
 * missing under `NODE_ENV=production` — adding a binding that must be rebuilt on
 * every Node bump is a liability for a convenience feature.
 *
 * The cost is honest: this is a poll-and-capture terminal, not a faithful
 * emulator. Full-screen TUIs render as their current frame, and there is no
 * scrollback beyond what the pane holds. Good enough to run a command, watch an
 * agent work, and answer a prompt.
 *
 * ── WHAT THIS IS, PLAINLY ────────────────────────────────────────────────────
 * A root shell reachable from a browser tab. It binds to 127.0.0.1 and sits
 * behind the same NextAuth wall as the rest of the desktop, which is the same
 * trust boundary the vault, secrets and pm2 controls already live behind — but
 * it is a bigger blast radius than any of them, and pretending otherwise in a
 * comment would be the kind of quiet lie this codebase keeps deleting. There is
 * no command allow-list on purpose: an allow-list on a shell that can run `bash`
 * is theatre, and theatre is worse than a clearly-labelled door.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";

import { runCommand } from "../lib/connection-status.ts";

const r = new Hono();
const TMUX_BIN = "/usr/bin/tmux";

/** Every session this OS created, id → tmux name. tmux is the source of truth
 *  for liveness; this map only remembers which panes are OURS, so the broker's
 *  `cliauth-*` sessions and Konrad's own tmux work never appear in the UI. */
const owned = new Map<string, { name: string; title: string; created: string }>();

const PREFIX = "forge-term-";

async function tmuxCmd(args: readonly string[], timeoutMs = 10_000) {
  return await runCommand(TMUX_BIN, args, { timeoutMs, env: process.env });
}

async function alive(name: string): Promise<boolean> {
  const out = await tmuxCmd(["has-session", "-t", name]);
  return out.code === 0;
}

/**
 * Named keys tmux understands, and nothing else.
 *
 * Literal text goes through `send-keys -l` where tmux treats it as data. This
 * list is what lets the UI send Ctrl-C and the arrows WITHOUT opening a hole
 * where arbitrary text is interpreted as a key sequence — `send-keys` without
 * `-l` would turn a pasted string containing "C-c" into an interrupt.
 */
const NAMED_KEYS = new Set([
  "Enter", "Escape", "Tab", "BSpace", "Space",
  "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown",
  "C-c", "C-d", "C-z", "C-l", "C-a", "C-e", "C-u", "C-k", "C-r", "C-p", "C-n",
]);

/* ── List ─────────────────────────────────────────────────────────────────── */

r.get("/sessions", async (c) => {
  const sessions = [];
  for (const [id, meta] of owned) {
    const isAlive = await alive(meta.name);
    if (!isAlive) {
      owned.delete(id);
      continue;
    }
    sessions.push({ id, title: meta.title, created_at: meta.created, alive: true });
  }
  return c.json({ sessions });
});

/* ── Create ───────────────────────────────────────────────────────────────── */

r.post("/sessions", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const cwd = typeof body.cwd === "string" && body.cwd.trim() !== "" ? body.cwd.trim() : "/opt/forge-ai-os";
  const cols = Number.isInteger(body.cols) ? Math.min(Math.max(body.cols as number, 40), 400) : 120;
  const rows = Number.isInteger(body.rows) ? Math.min(Math.max(body.rows as number, 10), 200) : 32;
  const title = typeof body.title === "string" && body.title.trim() !== "" ? body.title.trim().slice(0, 60) : "shell";

  const id = randomUUID();
  const name = `${PREFIX}${id.slice(0, 8)}`;

  // `-c` sets the working directory rather than embedding a `cd` in a shell
  // string, so a path with a space or a quote cannot become a second command.
  const created = await tmuxCmd([
    "new-session", "-d", "-s", name,
    "-c", cwd,
    "-x", String(cols), "-y", String(rows),
  ]);
  if (created.code !== 0) {
    return c.json({ error: "could not start a terminal", detail: created.stderr.trim() || "tmux refused" }, 500);
  }

  // Remove the status bar: it is a full row of chrome that means nothing in a
  // browser pane and costs a line of visible output on every capture.
  await tmuxCmd(["set-option", "-t", name, "status", "off"]);

  const meta = { name, title, created: new Date().toISOString() };
  owned.set(id, meta);
  return c.json({ id, title, created_at: meta.created, alive: true, cwd, cols, rows });
});

/* ── Read ─────────────────────────────────────────────────────────────────── */

r.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const meta = owned.get(id);
  if (meta === undefined) return c.json({ error: "no such terminal" }, 404);

  if (!(await alive(meta.name))) {
    owned.delete(id);
    return c.json({ id, alive: false, content: "", title: meta.title, detail: "This terminal has exited." });
  }

  // -J joins wrapped lines; -e is deliberately NOT passed, so the payload is
  // plain text rather than ANSI. A browser pane that renders escape codes as
  // literal garbage is worse than one that renders no colour.
  const out = await tmuxCmd(["capture-pane", "-p", "-J", "-t", meta.name]);
  if (out.code !== 0) {
    return c.json({ id, alive: false, content: "", title: meta.title, detail: out.stderr.trim() || "capture failed" });
  }

  // Trailing blank lines are the pane's empty rows, not output. Kept leading
  // whitespace: indentation is meaningful in everything a shell prints.
  const content = out.stdout.replace(/\s+$/, "");
  return c.json({ id, alive: true, title: meta.title, content });
});

/* ── Write ────────────────────────────────────────────────────────────────── */

r.post("/sessions/:id/input", async (c) => {
  const id = c.req.param("id");
  const meta = owned.get(id);
  if (meta === undefined) return c.json({ error: "no such terminal" }, 404);
  if (!(await alive(meta.name))) {
    owned.delete(id);
    return c.json({ error: "this terminal has exited" }, 409);
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = typeof body.text === "string" ? body.text : "";
  const key = typeof body.key === "string" ? body.key : "";
  const submit = body.submit === true;

  if (text === "" && key === "" && !submit) {
    return c.json({ error: "nothing to send" }, 400);
  }

  if (text !== "") {
    if (Buffer.byteLength(text, "utf8") > 100_000) {
      return c.json({ error: "input too large" }, 400);
    }
    // -l: LITERAL. Without it tmux parses the string for key names, so a paste
    // containing "C-c" would interrupt the process instead of being typed.
    const sent = await tmuxCmd(["send-keys", "-t", meta.name, "-l", text]);
    if (sent.code !== 0) {
      return c.json({ error: "could not send input", detail: sent.stderr.trim() }, 500);
    }
  }

  if (key !== "") {
    if (!NAMED_KEYS.has(key)) return c.json({ error: `unsupported key: ${key}` }, 400);
    const sent = await tmuxCmd(["send-keys", "-t", meta.name, key]);
    if (sent.code !== 0) {
      return c.json({ error: "could not send key", detail: sent.stderr.trim() }, 500);
    }
  }

  if (submit) await tmuxCmd(["send-keys", "-t", meta.name, "Enter"]);

  return c.json({ ok: true });
});

/* ── Resize ───────────────────────────────────────────────────────────────── */

r.post("/sessions/:id/resize", async (c) => {
  const id = c.req.param("id");
  const meta = owned.get(id);
  if (meta === undefined) return c.json({ error: "no such terminal" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const cols = Number.isInteger(body.cols) ? Math.min(Math.max(body.cols as number, 40), 400) : null;
  const rows = Number.isInteger(body.rows) ? Math.min(Math.max(body.rows as number, 10), 200) : null;
  if (cols === null || rows === null) return c.json({ error: "cols and rows must be integers" }, 400);

  await tmuxCmd(["resize-window", "-t", meta.name, "-x", String(cols), "-y", String(rows)]);
  return c.json({ ok: true, cols, rows });
});

/* ── Kill ─────────────────────────────────────────────────────────────────── */

r.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const meta = owned.get(id);
  if (meta === undefined) return c.json({ error: "no such terminal" }, 404);
  await tmuxCmd(["kill-session", "-t", meta.name]);
  owned.delete(id);
  return c.json({ ok: true });
});

export default r;
