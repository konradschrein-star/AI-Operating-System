/**
 * tool-summary.ts — the one-line human summary of a tool call (U23).
 *
 * Pure, React-free, dependency-free. Round 601A builds it; rounds 602/603
 * render it. Nothing in here reads a clock, fetches, or calls an LLM.
 *
 * WHY A TABLE, NOT A CHAIN OF IFS
 * `13-ui-v3-architecture.md §8` is explicit: "Formatters are a table, not a
 * chain of ifs, so adding tools is a row." `TOOL_FORMATTERS` is that table.
 * Adding support for a new tool is one entry; it cannot regress the others.
 *
 * WIRE FACTS (verified round 600 against run 3853c154-e07b-4378-9313-2b34f4a33342,
 * 285 entries — fixture at docs/plan/artifacts/phase600/fixtures/):
 *   - a tool_call entry carries `meta.tool` (string) and `meta.input`
 *     (a JSON **string**, not an object) plus `meta.tool_use_id`;
 *   - its outcome lives in a later tool_result entry with the same
 *     `meta.tool_use_id`, `content` = the result text, `meta.is_error` = bool;
 *   - tools actually observed in that run: Bash 99, Read 26, Write 6, Agent 2,
 *     ScheduleWakeup 2, Grep 1 — the last one is why the Fallback row matters.
 *
 * THE PAYLOAD IS CLIPPED AT THE SOURCE (measured on that same run):
 *   `meta.input` is stored clipped to 1500 characters + "…", which makes it
 *   INVALID JSON for every call with a large argument — 10 of that run's 136
 *   tool calls, including both `Agent` spawns and every `Write`. A parser that
 *   only tries `JSON.parse` therefore shows nothing useful exactly where the
 *   story matters most. `salvageArgs` recovers the leading key/value pairs
 *   from such a prefix, and `FormatterInput.argsSource` says which path was
 *   taken so a row can refuse to report a size it cannot trust (Write/Edit do).
 *   Consequence for U23's "expand to raw payload": the raw payload the thread
 *   holds IS the clipped one — documented in
 *   docs/plan/artifacts/phase600/digest-gap.md, not papered over here.
 *
 * TWO HARD RULES
 * 1. NEVER THROW on malformed input. `meta.input` is wire data; a truncated or
 *    non-JSON payload is a display problem, not a crash. Every parse is
 *    defensive and every failure degrades to a visible, honest summary.
 *    (A formatter that throws IS a code bug — that is caught too, but it is
 *    reported as `formatter failed: …` with tone "error", never swallowed.)
 * 2. NEVER MUTATE OR TRUNCATE THE PAYLOAD. Everything here derives a *new*
 *    short string. The caller keeps `meta.input` and the result text whole so
 *    round 602's expand can show the raw bytes.
 */

export type ToolTone = "ok" | "error" | "pending";

/**
 * The collapsed row: `[label] [gist] → [outcome]`.
 * `label` is the verb ("bash", "read", "spawn"), `gist` the argument in one
 * glance, `outcome` what came back. `tone` drives the token color at render.
 */
export type ToolSummary = {
  label: string;
  gist: string;
  outcome: string;
  tone: ToolTone;
};

/** How `FormatterInput.args` was obtained. See `parseArgsWithSource`. */
export type ArgsSource = "json" | "salvaged" | "none";

/** What a formatter row receives. All fields are already normalized. */
export interface FormatterInput {
  /**
   * `meta.input` as a plain object, or `null` when it was absent, unusable, or
   * not an object (a bare string/array/number payload).
   */
  readonly args: Readonly<Record<string, unknown>> | null;
  /**
   * "json" — parsed whole; "salvaged" — recovered from a clipped prefix, so
   * any length-derived fact about it is a floor, not a measurement;
   * "none" — nothing usable.
   */
  readonly argsSource: ArgsSource;
  /** `meta.input` exactly as it arrived — never mutated, never clipped. */
  readonly argsText: string;
  /** The tool_result text, or `null` while the call is still outstanding. */
  readonly result: string | null;
  /** `meta.is_error` — passed through for rows that want it. */
  readonly isError: boolean;
}

/**
 * A row. Returns only the happy-path outcome: `summarizeTool` overrides the
 * outcome for pending and error calls centrally (see below), so a new row
 * never has to re-implement those two cases.
 */
export type Formatter = (input: FormatterInput) => {
  label: string;
  gist: string;
  outcome: string;
};

/* ── Display budgets ───────────────────────────────────────────────────────
 * Derived-string limits only. The underlying payload is untouched. */
const GIST_MAX = 72;
const OUTCOME_MAX = 64;
/** A scalar value rendered into the Fallback row's `k=v` gist. */
const SCALAR_MAX = 32;
/** Shown instead of an outcome while no tool_result has arrived yet. */
const PENDING_OUTCOME = "running…";
/**
 * Shown instead of a gist when the payload collapses to nothing — `""`,
 * whitespace only, or absent. A blank gist is the one failure mode a summary
 * row must not have: the row still draws (dot, label, outcome, chevron), so an
 * empty string reads as "this call had no arguments worth showing" when the
 * truth is "the executor wrote us nothing". Say which.
 *
 * Not reachable through the live engine — `executor.ts` writes
 * `JSON.stringify(e.toolInput ?? {})`, so `meta.input` is at minimum `"{}"`,
 * and `thread-mapping.ts` falls back to the entry `content` when `meta.input`
 * is absent. It is reachable from a hand-built fixture, a future writer that
 * does not go through the executor, and any caller of the exported
 * `summarizeTool`. Guarded here, once, rather than per row.
 */
const EMPTY_GIST = "no arguments";

/* ── Small pure helpers ───────────────────────────────────────────────────── */

/** Whitespace-collapse for one-line gists. The raw payload keeps its newlines. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Clip to `max` characters, marking the cut. Never widens, never throws. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function firstNonEmptyLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** Lines in a result body; an all-whitespace body counts as 0. */
function lineCount(s: string): number {
  const t = s.trim();
  return t === "" ? 0 : t.split("\n").length;
}

function plural(n: number, word: string, suffix = "s"): string {
  return `${n} ${word}${n === 1 ? "" : suffix}`;
}

/** 987 → "987", 12345 → "12.3k", 1_200_000 → "1.2M". */
function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * `/opt/ai-os/…/app/desktop/live/AgentActivity.tsx` → `…/live/AgentActivity.tsx`.
 * Absolute worktree paths are 80+ characters of noise; the last two segments
 * are what a reader recognizes. The full path stays in the expanded payload.
 */
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

/** `meta.input` → object, or null. Defensive by contract: never throws. */
export function parseArgs(
  argsText: string | null | undefined,
): Record<string, unknown> | null {
  if (typeof argsText !== "string" || argsText.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Recover what can be read from a CLIPPED JSON object (`{"a":"x","b":12,…`).
 * Scans leading `"key": <scalar>` pairs and stops at the first thing it cannot
 * read whole — the half-written value at the cut is never guessed at.
 *
 * Deliberately shallow: it walks only the top level, so it cannot mistake a
 * nested `{"file_path": …}` for the call's own. Objects and arrays end the
 * scan rather than being descended into.
 *
 * Returns `null` when nothing was recoverable. Never throws.
 */
export function salvageArgs(
  argsText: string | null | undefined,
): Record<string, unknown> | null {
  if (typeof argsText !== "string") return null;
  const text = argsText.trimStart();
  if (!text.startsWith("{")) return null;

  const out: Record<string, unknown> = {};
  // Sticky (`y`): each pair must begin exactly where the previous one ended,
  // so a nested object/array simply stops the scan instead of being descended
  // into — we can never report some inner object's keys as the call's own.
  // "key" : "value" | number | true | false | null
  const pair =
    /\s*"((?:[^"\\]|\\.)*)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?)|(true|false|null))\s*(,|\})/y;
  pair.lastIndex = 1; // just past the opening brace
  for (;;) {
    const m = pair.exec(text);
    if (m === null) break;
    let key: string;
    try {
      key = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      break;
    }
    if (m[2] !== undefined) {
      try {
        out[key] = JSON.parse(`"${m[2]}"`) as string;
      } catch {
        break;
      }
    } else if (m[3] !== undefined) {
      out[key] = Number(m[3]);
    } else {
      out[key] = m[4] === "true" ? true : m[4] === "false" ? false : null;
    }
    if (m[5] === "}") break;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** `meta.input` → object + how we got it. Never throws. */
export function parseArgsWithSource(argsText: string | null | undefined): {
  args: Record<string, unknown> | null;
  source: ArgsSource;
} {
  const parsed = parseArgs(argsText);
  if (parsed !== null) return { args: parsed, source: "json" };
  const salvaged = salvageArgs(argsText);
  if (salvaged !== null) return { args: salvaged, source: "salvaged" };
  return { args: null, source: "none" };
}

function str(
  args: Readonly<Record<string, unknown>> | null,
  key: string,
): string | null {
  const v = args?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function num(
  args: Readonly<Record<string, unknown>> | null,
  key: string,
): number | null {
  const v = args?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function arr(
  args: Readonly<Record<string, unknown>> | null,
  key: string,
): unknown[] | null {
  const v = args?.[key];
  return Array.isArray(v) ? v : null;
}

/**
 * The gist when a row's expected argument key is missing: the raw payload,
 * collapsed and clipped. Honest — you see what actually arrived. When what
 * arrived collapses to nothing, say so rather than rendering a blank cell.
 */
function rawGist(input: FormatterInput): string {
  const text = collapse(input.argsText);
  return text === "" ? EMPTY_GIST : clip(text, GIST_MAX);
}

/** `N chars` for result bodies whose shape we cannot count meaningfully. */
function sizeOutcome(result: string | null): string {
  if (result === null || result === "") return "no output";
  return `${fmtCount(result.length)} chars`;
}

/**
 * The error outcome, shared by every row: CC wraps tool failures in
 * `<tool_use_error>…</tool_use_error>`; unwrap it and show the first line.
 */
function errorOutcome(result: string | null): string {
  if (result === null) return "failed";
  const unwrapped = result
    .replace(/<\/?tool_use_error>/g, " ")
    .replace(/<\/?error>/g, " ");
  const line = firstNonEmptyLine(unwrapped);
  return line === "" ? "failed" : clip(collapse(line), OUTCOME_MAX);
}

/* ── The table ─────────────────────────────────────────────────────────────
 * One row per tool. Adding a tool = adding a row. Keys match `meta.tool`
 * verbatim (case-sensitive, as the executor writes it); "Fallback" is the
 * reserved row `summarizeTool` falls back to and is NOT a real tool name. */

const bash: Formatter = (input) => {
  const command = str(input.args, "command");
  return {
    label: "bash",
    // via rawGist, not a bare `?? input.argsText`, so the empty-payload
    // placeholder is the table's behaviour and not one row's.
    gist: command === null ? rawGist(input) : clip(collapse(command), GIST_MAX),
    outcome:
      input.result === null || lineCount(input.result) === 0
        ? "no output"
        : plural(lineCount(input.result), "line"),
  };
};

const read: Formatter = (input) => {
  const path = str(input.args, "file_path");
  const offset = num(input.args, "offset");
  const base = path === null ? rawGist(input) : shortPath(path);
  return {
    label: "read",
    gist: clip(offset === null ? base : `${base} @${offset}`, GIST_MAX),
    outcome:
      input.result === null ? "no output" : plural(lineCount(input.result), "line"),
  };
};

const write: Formatter = (input) => {
  const path = str(input.args, "file_path");
  const content = str(input.args, "content");
  return {
    label: "write",
    gist: path === null ? rawGist(input) : clip(shortPath(path), GIST_MAX),
    // A salvaged payload was clipped at 1500 chars, so `content.length` is the
    // length of the clip, not of the file. Say "written" rather than a number
    // that is confidently wrong.
    outcome:
      content === null || input.argsSource === "salvaged"
        ? "written"
        : `${fmtCount(content.length)} chars written`,
  };
};

const edit: Formatter = (input) => {
  const path = str(input.args, "file_path");
  const all = input.args?.replace_all === true;
  const oldText = str(input.args, "old_string");
  const newText = str(input.args, "new_string");
  const base = path === null ? rawGist(input) : shortPath(path);
  return {
    label: "edit",
    gist: clip(all ? `${base} (all)` : base, GIST_MAX),
    // Same rule as `write`: a clipped payload cannot be measured (see above).
    outcome:
      oldText === null || newText === null || input.argsSource === "salvaged"
        ? "edited"
        : `${fmtCount(oldText.length)} → ${fmtCount(newText.length)} chars`,
  };
};

const multiEdit: Formatter = (input) => {
  const path = str(input.args, "file_path");
  const edits = arr(input.args, "edits");
  const base = path === null ? rawGist(input) : shortPath(path);
  return {
    label: "multiedit",
    gist: clip(edits === null ? base : `${base} ×${edits.length}`, GIST_MAX),
    outcome:
      edits === null ? "edited" : `${plural(edits.length, "edit")} applied`,
  };
};

const grep: Formatter = (input) => {
  const pattern = str(input.args, "pattern");
  const glob = str(input.args, "glob");
  const path = str(input.args, "path");
  let gist = pattern === null ? rawGist(input) : `"${pattern}"`;
  if (glob !== null) gist += ` [${glob}]`;
  if (path !== null) gist += ` in ${shortPath(path)}`;
  const n = input.result === null ? 0 : lineCount(input.result);
  return {
    label: "grep",
    gist: clip(collapse(gist), GIST_MAX),
    outcome: n === 0 ? "no matches" : plural(n, "match", "es"),
  };
};

const glob: Formatter = (input) => {
  const pattern = str(input.args, "pattern");
  const path = str(input.args, "path");
  let gist = pattern === null ? rawGist(input) : pattern;
  if (path !== null) gist += ` in ${shortPath(path)}`;
  const n = input.result === null ? 0 : lineCount(input.result);
  return {
    label: "glob",
    gist: clip(collapse(gist), GIST_MAX),
    outcome: n === 0 ? "no files" : plural(n, "file"),
  };
};

/**
 * Task/Agent — the row that makes the org chart legible. `subagent_type` is
 * the role the panel shows; `description` is the brief a human recognizes.
 * An async spawn returns the harness's "Async agent launched successfully…"
 * banner (its entries land INLINE in this run's thread, tagged
 * `meta.parent_tool_use_id` — see subagent-slice.ts); a synchronous one
 * returns the sub-agent's final text, so its size is the honest outcome.
 */
const spawn: Formatter = (input) => {
  const role = str(input.args, "subagent_type") ?? "agent";
  const description =
    str(input.args, "description") ??
    (str(input.args, "prompt") === null
      ? null
      : clip(collapse(str(input.args, "prompt") ?? ""), 48));
  return {
    label: "spawn",
    gist: clip(
      description === null ? role : `${role} · ${description}`,
      GIST_MAX,
    ),
    outcome:
      input.result !== null && input.result.includes("Async agent launched")
        ? "launched"
        : sizeOutcome(input.result),
  };
};

/**
 * SendMessage — the operator's own outbound line to a sub-agent or fellow
 * session. The CLI duplicates both ends of the call (`to`/`recipient` name
 * the recipient, `message`/`content` carry the body); prefer the primary
 * name and fall back to the duplicate so a payload carrying only one pair
 * still renders.
 */
const sendMessage: Formatter = (input) => {
  const to = str(input.args, "to") ?? str(input.args, "recipient");
  const message = str(input.args, "message") ?? str(input.args, "content");
  let gist: string;
  if (to === null && message === null) {
    gist = rawGist(input);
  } else {
    const raw =
      to === null ? (message ?? "") : message === null ? `-> ${to}` : `-> ${to} · ${message}`;
    gist = clip(collapse(raw), GIST_MAX);
  }
  return {
    label: "send",
    gist,
    outcome:
      input.result === null || input.result.trim() === ""
        ? "no reply"
        : clip(collapse(firstNonEmptyLine(input.result)), OUTCOME_MAX),
  };
};

const skill: Formatter = (input) => {
  const name = str(input.args, "skill") ?? str(input.args, "name");
  const skillArgs = str(input.args, "args");
  const base = name === null ? rawGist(input) : name;
  return {
    label: "skill",
    gist: clip(skillArgs === null ? base : `${base} ${skillArgs}`, GIST_MAX),
    outcome:
      input.result === null || input.result.trim() === ""
        ? "no output"
        : clip(collapse(firstNonEmptyLine(input.result)), OUTCOME_MAX),
  };
};

const webFetch: Formatter = (input) => {
  const url = str(input.args, "url");
  return {
    label: "fetch",
    gist: url === null ? rawGist(input) : clip(collapse(url), GIST_MAX),
    outcome: sizeOutcome(input.result),
  };
};

const webSearch: Formatter = (input) => {
  const query = str(input.args, "query");
  return {
    label: "search",
    gist: clip(query === null ? rawGist(input) : `"${query}"`, GIST_MAX),
    outcome: sizeOutcome(input.result),
  };
};

const todoWrite: Formatter = (input) => {
  const todos = arr(input.args, "todos");
  if (todos === null) {
    return { label: "todo", gist: rawGist(input), outcome: "updated" };
  }
  const statusOf = (t: unknown): string =>
    t !== null && typeof t === "object" && typeof (t as { status?: unknown }).status === "string"
      ? ((t as { status: string }).status)
      : "";
  const contentOf = (t: unknown): string =>
    t !== null && typeof t === "object" && typeof (t as { content?: unknown }).content === "string"
      ? ((t as { content: string }).content)
      : "";
  const active = todos.find((t) => statusOf(t) === "in_progress");
  const done = todos.filter((t) => statusOf(t) === "completed").length;
  return {
    label: "todo",
    gist: clip(
      active === undefined
        ? plural(todos.length, "item")
        : collapse(contentOf(active)),
      GIST_MAX,
    ),
    outcome: `${done}/${todos.length} done`,
  };
};

/**
 * Fallback — every tool without a row of its own. It must still say something
 * true, so it renders the first two scalar arguments as `key=value` (object
 * key order is JSON insertion order, hence deterministic for a given payload)
 * and falls back to the raw payload when there are none.
 */
const fallback: Formatter = (input) => {
  const pairs: string[] = [];
  if (input.args !== null) {
    for (const [k, v] of Object.entries(input.args)) {
      if (pairs.length >= 2) break;
      if (typeof v === "string") pairs.push(`${k}=${clip(collapse(v), SCALAR_MAX)}`);
      else if (typeof v === "number" || typeof v === "boolean") pairs.push(`${k}=${String(v)}`);
    }
  }
  return {
    label: "tool",
    gist: pairs.length > 0 ? clip(pairs.join(" "), GIST_MAX) : rawGist(input),
    outcome: sizeOutcome(input.result),
  };
};

/** The key `summarizeTool` uses when `meta.tool` matches no row. */
export const FALLBACK_KEY = "Fallback";

export const TOOL_FORMATTERS: Record<string, Formatter> = {
  Bash: bash,
  Read: read,
  Write: write,
  Edit: edit,
  MultiEdit: multiEdit,
  Grep: grep,
  Glob: glob,
  Task: spawn,
  Agent: spawn,
  SendMessage: sendMessage,
  Skill: skill,
  WebFetch: webFetch,
  WebSearch: webSearch,
  TodoWrite: todoWrite,
  [FALLBACK_KEY]: fallback,
};

/**
 * Summarize one tool call.
 *
 * @param toolName `meta.tool` from the tool_call entry.
 * @param argsText `meta.input` — a JSON **string**. Malformed is fine.
 * @param result   the matching tool_result's `content`, or null/undefined
 *                 while the call is still outstanding.
 * @param isError  the tool_result's `meta.is_error`.
 *
 * Outcome precedence, applied here so no row repeats it:
 *   no result yet → tone "pending", outcome "running…"
 *   is_error      → tone "error",   outcome = first line of the failure
 *   otherwise     → tone "ok",      outcome = the row's own
 *
 * Never throws. A row that throws is a bug in this file, and it surfaces as
 * `formatter failed: <message>` with tone "error" rather than a blank line or
 * a crashed transcript.
 */
export function summarizeTool(
  toolName: string,
  argsText: string | null | undefined,
  result: string | null | undefined,
  isError: boolean,
): ToolSummary {
  const name = typeof toolName === "string" ? toolName.trim() : "";
  const res = typeof result === "string" ? result : null;
  const text = typeof argsText === "string" ? argsText : "";
  const formatter = TOOL_FORMATTERS[name] ?? TOOL_FORMATTERS[FALLBACK_KEY];

  let row: { label: string; gist: string; outcome: string };
  try {
    const { args, source } = parseArgsWithSource(text);
    row = formatter({ args, argsSource: source, argsText: text, result: res, isError });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      label: name || "tool",
      gist: clip(collapse(text), GIST_MAX),
      outcome: clip(`formatter failed: ${message}`, OUTCOME_MAX),
      tone: "error",
    };
  }

  // The Fallback row cannot know the tool's name; give it the real one so an
  // unmapped tool still reads as itself ("ScheduleWakeup", not "tool").
  const label = formatter === fallback && name !== "" ? name : row.label;

  if (res === null) {
    return { label, gist: row.gist, outcome: PENDING_OUTCOME, tone: "pending" };
  }
  if (isError) {
    return { label, gist: row.gist, outcome: errorOutcome(res), tone: "error" };
  }
  return { label, gist: row.gist, outcome: row.outcome, tone: "ok" };
}
