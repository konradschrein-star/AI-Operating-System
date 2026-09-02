/**
 * Owner-facing runtime connections.  This deliberately exposes only the two
 * fixed CLI login programs; it is not a web shell and accepts no commands.
 */
import { Hono } from "hono";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const r = new Hono();

type ProviderId = "claude" | "codex";
type LoginSession = {
  id: ProviderId;
  child: ChildProcessWithoutNullStreams;
  output: string;
  startedAt: string;
  finished: boolean;
  exitCode: number | null;
  timer: NodeJS.Timeout;
};

const sessions = new Map<ProviderId, LoginSession>();
const SESSION_TTL_MS = 10 * 60_000;
const SKILLS_ROOT = process.env.SKILLS_ROOT ?? "/root/.claude/skills";
const CLAUDE_CREDS = process.env.CLAUDE_CREDENTIALS_PATH ?? "/root/.claude/.credentials.json";
const CODEX_CREDS = process.env.CODEX_AUTH_PATH ?? "/root/.codex/auth.json";

async function exists(path: string, wantDirectory = false): Promise<boolean> {
  try {
    if (wantDirectory) return (await stat(path)).isDirectory();
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function clean(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

async function status() {
  const [claudeInstalled, codexInstalled, claudeConnected, codexConnected, skillsReady] =
    await Promise.all([
      commandAvailable("claude"),
      commandAvailable("codex"),
      exists(CLAUDE_CREDS),
      exists(CODEX_CREDS),
      exists(SKILLS_ROOT, true),
    ]);
  return {
    providers: [
      { id: "claude", installed: claudeInstalled, connected: claudeConnected },
      // Agy has no configured provider adapter in this repository yet.  Say
      // that plainly rather than inventing quota numbers.
      { id: "agy", installed: false, connected: false, configured: false },
      { id: "codex", installed: codexInstalled, connected: codexConnected },
    ],
    skills: { root: SKILLS_ROOT, ready: skillsReady },
  };
}

r.get("/", async (c) => c.json(await status()));

/** Start an interactive OAuth session in a PTY. Output is polled by Settings;
 * users may only send keystrokes to this fixed authentication process. */
r.post("/:provider/start", async (c) => {
  const id = c.req.param("provider") as ProviderId;
  if (id !== "claude" && id !== "codex") return c.json({ error: "unknown provider" }, 404);
  const old = sessions.get(id);
  if (old && !old.finished) return c.json(sessionView(old));

  const command = id === "claude" ? "claude" : "codex login";
  // `script` supplies the TTY expected by both CLIs, while keeping the only
  // executable command server-controlled.
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: process.env.CC_WORKSPACE ?? "/opt/ai-os/workspace",
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const session: LoginSession = {
    id,
    child,
    output: "Starting secure login session…\n",
    startedAt: new Date().toISOString(),
    finished: false,
    exitCode: null,
    timer: setTimeout(() => child.kill("SIGTERM"), SESSION_TTL_MS),
  };
  sessions.set(id, session);
  const append = (data: Buffer) => {
    session.output = (session.output + clean(data.toString())).slice(-24_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("error", (e) => {
    session.output += `\nUnable to start login: ${e.message}\n`;
    session.finished = true;
  });
  child.once("exit", (code) => {
    clearTimeout(session.timer);
    session.finished = true;
    session.exitCode = code;
  });
  return c.json(sessionView(session), 201);
});

r.get("/:provider/session", (c) => {
  const session = sessions.get(c.req.param("provider") as ProviderId);
  return session ? c.json(sessionView(session)) : c.json({ active: false });
});

r.post("/:provider/input", async (c) => {
  const session = sessions.get(c.req.param("provider") as ProviderId);
  if (!session || session.finished) return c.json({ error: "no active login session" }, 409);
  const body = await c.req.json().catch(() => ({}));
  const input = typeof body.input === "string" ? body.input : "";
  // Login menus need only ordinary keystrokes; cap input and reject control
  // sequences except newline/backspace so this cannot turn into a shell.
  if (!input || input.length > 200 || /[^\x08\x0A\x0D\x20-\x7E]/.test(input)) {
    return c.json({ error: "invalid login input" }, 400);
  }
  session.child.stdin.write(input);
  return c.json(sessionView(session));
});

r.post("/:provider/cancel", (c) => {
  const session = sessions.get(c.req.param("provider") as ProviderId);
  if (session && !session.finished) session.child.kill("SIGTERM");
  return c.json({ active: false });
});

function sessionView(s: LoginSession) {
  return {
    active: !s.finished,
    started_at: s.startedAt,
    exit_code: s.exitCode,
    output: s.output,
  };
}

export default r;
