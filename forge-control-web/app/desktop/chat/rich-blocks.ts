/**
 * rich-blocks.ts — the ONLY way an agent gets an interactive control into
 * Konrad's transcript.
 *
 * Konrad, 2026-08-16: "I thought it would make sense to render the messages as
 * HTML, this way we can have more effective communication with selection
 * elements, you telling me secrets and so on."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A TYPED BLOCK AND NOT HTML
 * ═══════════════════════════════════════════════════════════════════════════
 * The literal reading of "render the messages as HTML" is: take model output
 * and put it in the DOM. That is an XSS hole in the operator console of a
 * machine that holds Konrad's credentials, and the model is not the only
 * author of its own output — an agent that read a hostile web page, cloned a
 * hostile repo or opened a hostile file is writing what the attacker chose.
 * Round 804 measured that threat on the secrets panel and proved eight
 * payloads render inert (docs/plan/artifacts/phase800/note-injection.cjs).
 * This round widens the rich surface and must not widen the hole.
 *
 * So the split is:
 *   PROSE      markdown, sanitised, no raw HTML, no remote resources —
 *              MessageMarkdown.tsx and rehype-forge-allowlist.ts.
 *   CONTROLS   a STRUCTURED payload the agent emits, validated here against a
 *              closed schema, rendered by components that already exist. The
 *              model never names a tag, an attribute, a colour, a URL or a
 *              handler. It names a KIND and some strings, and the strings go
 *              into React text nodes.
 *
 * An agent emits one by writing a fenced block whose info string is
 * `forge:ui`:
 *
 *     ```forge:ui
 *     {"kind":"choice","prompt":"Which host?","options":[
 *       {"value":"vps1","label":"VPS1","hint":"65.108.6.149"},
 *       {"value":"vps2","label":"VPS2","hint":"167.233.145.218"}]}
 *     ```
 *
 * ANYTHING that fails validation — malformed JSON, unknown kind, an option
 * list of 500, a label of 5 000 characters — becomes an `invalid` segment
 * carrying its reason, and renders as an inert code block. It is never
 * silently dropped: a control Konrad cannot see is worse than one he can see
 * is broken, and a swallowed parse error is how a hostile payload gets a
 * second try in the dark.
 *
 * Pure, React-free, dependency-free. `scripts/checks/check-chat-rich.ts`
 * imports it directly under tsx and runs the injection battery against it.
 */

/* ── Caps ─────────────────────────────────────────────────────────────────
 * Every one of these is a rendering bound, not a taste preference: the payload
 * is attacker-influenced, and an unbounded string or list is a way to push the
 * composer off the screen (round 804's `long-5000` payload) or to hide a
 * hostile option below the fold. */

export const LIMITS = {
  /** JSON source of one block. 8 KB is far more than any real control needs
   *  and small enough that parsing it on a render pass is free. */
  blockChars: 8_000,
  options: 12,
  promptChars: 400,
  labelChars: 80,
  valueChars: 400,
  hintChars: 160,
  idChars: 64,
  secretNameChars: 64,
  whyChars: 400,
} as const;

export type UiBlock = ChoiceBlock | SecretBlock;

/** A pick-one (or pick-several) option set. Clicking an option inserts its
 *  `value` into the composer draft — it never sends, and it never calls an
 *  endpoint. The agent proposes; Konrad still presses Enter. */
export interface ChoiceBlock {
  kind: "choice";
  /** Stable identity for the block, when the agent bothered to give one. Used
   *  only as a React key and a `data-` attribute; never interpolated into
   *  markup. */
  id: string | null;
  prompt: string | null;
  multiple: boolean;
  options: ChoiceOption[];
}

export interface ChoiceOption {
  /** What goes into the composer. */
  value: string;
  /** What the button says. Defaults to `value`. */
  label: string;
  /** One line of context under the label. */
  hint: string | null;
}

/**
 * "You telling me secrets and so on" — the ONE affordance in this file that
 * touches a credential, and it deliberately carries no credential. It opens
 * the existing secure panel (SecretField) with the name prefilled. The value
 * travels through `POST /api/secrets` and never enters the thread; round 804's
 * sentinel proves that path leaks nothing, and this block does not go near it.
 */
export interface SecretBlock {
  kind: "secret";
  name: string;
  why: string | null;
}

export type RichSegment =
  | { kind: "markdown"; text: string }
  | { kind: "ui"; block: UiBlock; raw: string }
  | { kind: "invalid"; raw: string; reason: string };

/* ── Text hygiene ─────────────────────────────────────────────────────────
 *
 * Block strings become BUTTON LABELS, which is a different threat from prose.
 * Prose is allowed to contain a bidi override and render it literally (round
 * 804 asserts exactly that, and reading a hostile note as it was written is
 * the honest behaviour). A control is not prose: a button whose label reverses
 * the text after it can present "cancel" where it will send "deploy". So the
 * bidi controls and every C0/C1 control character are replaced with U+FFFD in
 * block strings only — visible, one glyph per removed character, nothing
 * silently vanished.
 *
 * The prose path does NOT do this. Two surfaces, two correct answers.
 */
const CONTROL_CHARS =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** U+FFFD. One glyph per removed character, so a label that carried them
 *  still shows that something was taken out of it. */
export const REMOVED_CHAR = "\ufffd";

export function sanitizeControlText(s: string): string {
  return s.replace(CONTROL_CHARS, REMOVED_CHAR);
}

/* ── Fence scanning ───────────────────────────────────────────────────────
 *
 * Line-by-line, tracking fence state. A ```forge:ui INSIDE another fenced code
 * block is NOT a control — it is somebody quoting the format, which is exactly
 * what this file's own documentation does. A regex over the whole string
 * cannot tell those apart; a scanner can, so this is a scanner.
 */

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/;

interface Fence {
  indent: number;
  marker: string;
  info: string;
}

function openFence(line: string): Fence | null {
  const m = FENCE.exec(line);
  if (!m) return null;
  return { indent: m[1].length, marker: m[2], info: m[3].toLowerCase() };
}

/** A closing fence is the same character, at least as long, with no info. */
function closesFence(line: string, open: Fence): boolean {
  const m = FENCE.exec(line);
  if (!m) return false;
  if (m[3] !== "") return false;
  return m[2][0] === open.marker[0] && m[2].length >= open.marker.length;
}

const UI_INFO = "forge:ui";

/**
 * Split a message into prose and control segments.
 *
 * Consecutive prose is coalesced so the markdown parser sees one document per
 * run of prose rather than one per line — parsing is the most expensive thing
 * this transcript does (MessageMarkdown is memoised for that reason).
 */
export function splitRichSegments(source: string): RichSegment[] {
  if (typeof source !== "string" || source === "") return [];
  const lines = source.split("\n");
  const out: RichSegment[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length === 0) return;
    const text = prose.join("\n");
    prose = [];
    // Whitespace-only prose between two blocks is not a paragraph.
    if (text.trim() !== "") out.push({ kind: "markdown", text });
  };

  for (let i = 0; i < lines.length; i++) {
    const fence = openFence(lines[i]);
    if (fence === null) {
      prose.push(lines[i]);
      continue;
    }

    // Collect the fenced body either way — a normal code fence is prose and
    // must be handed to the markdown parser verbatim, INCLUDING any nested
    // `forge:ui` line, which is why the scan resumes after the whole fence.
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      if (closesFence(lines[j], fence)) {
        closed = true;
        break;
      }
      body.push(lines[j]);
    }

    if (fence.info !== UI_INFO) {
      prose.push(lines[i], ...body);
      if (closed) prose.push(lines[j]);
      i = j;
      continue;
    }

    flushProse();
    const raw = body.join("\n");
    if (!closed) {
      /* An unterminated control block. Streaming is the innocent explanation
       * and truncation is the hostile one; neither is a reason to render half
       * a button, so it shows as what it is. */
      out.push({ kind: "invalid", raw, reason: "unterminated forge:ui block" });
      i = j;
      continue;
    }
    out.push(parseSegment(raw));
    i = j;
  }

  flushProse();
  return out;
}

function parseSegment(raw: string): RichSegment {
  const parsed = parseUiBlock(raw);
  return parsed.ok
    ? { kind: "ui", block: parsed.block, raw }
    : { kind: "invalid", raw, reason: parsed.reason };
}

/* ── Validation ───────────────────────────────────────────────────────────── */

export type UiBlockResult =
  | { ok: true; block: UiBlock }
  | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** A required string: present, non-empty after sanitising, within its cap. */
function reqStr(
  v: unknown,
  field: string,
  cap: number,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof v !== "string") return fail(`${field} must be a string`);
  const clean = sanitizeControlText(v).trim();
  if (clean === "") return fail(`${field} is empty`);
  if (clean.length > cap) return fail(`${field} exceeds ${cap} characters`);
  return { ok: true, value: clean };
}

/** An optional string: absent/null is fine, wrong type or oversize is not.
 *  Silently truncating would let a 5 000-character "hint" decide the layout. */
function optStr(
  v: unknown,
  field: string,
  cap: number,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  const r = reqStr(v, field, cap);
  return r.ok ? { ok: true, value: r.value } : r;
}

/** Secret names are server-normalised (`routes/secrets.ts`); anything outside
 *  that alphabet is not a name this app could store, so it is refused rather
 *  than passed to the panel. */
const SECRET_NAME = /^[A-Za-z0-9._-]+$/;
const BLOCK_ID = /^[A-Za-z0-9._:-]+$/;

export function parseUiBlock(raw: string): UiBlockResult {
  if (typeof raw !== "string") return fail("block is not text");
  if (raw.length > LIMITS.blockChars) {
    return fail(`block exceeds ${LIMITS.blockChars} characters`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return fail(`not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return fail("block must be a JSON object");
  }
  const o = data as Record<string, unknown>;
  if (o.kind === "choice") return parseChoice(o);
  if (o.kind === "secret") return parseSecret(o);
  return fail(
    typeof o.kind === "string"
      ? `unknown kind "${sanitizeControlText(o.kind).slice(0, 40)}"`
      : "block has no kind",
  );
}

function parseChoice(o: Record<string, unknown>): UiBlockResult {
  const id = optStr(o.id, "id", LIMITS.idChars);
  if (!id.ok) return id;
  if (id.value !== null && !BLOCK_ID.test(id.value)) return fail("id has illegal characters");

  const prompt = optStr(o.prompt, "prompt", LIMITS.promptChars);
  if (!prompt.ok) return prompt;

  if (o.multiple !== undefined && typeof o.multiple !== "boolean") {
    return fail("multiple must be a boolean");
  }

  if (!Array.isArray(o.options)) return fail("options must be an array");
  if (o.options.length === 0) return fail("options is empty");
  if (o.options.length > LIMITS.options) {
    return fail(`options exceeds ${LIMITS.options} entries`);
  }

  const options: ChoiceOption[] = [];
  for (let i = 0; i < o.options.length; i++) {
    const entry = o.options[i];
    /* A bare string is allowed — `"options": ["yes", "no"]` is what an agent
     * writes when it has nothing else to say, and refusing it would push
     * authors toward hand-built markdown, which is the surface this file
     * exists to replace. */
    if (typeof entry === "string") {
      const value = reqStr(entry, `options[${i}]`, LIMITS.valueChars);
      if (!value.ok) return value;
      options.push({ value: value.value, label: value.value, hint: null });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return fail(`options[${i}] must be a string or an object`);
    }
    const e = entry as Record<string, unknown>;
    const value = reqStr(e.value, `options[${i}].value`, LIMITS.valueChars);
    if (!value.ok) return value;
    const label = optStr(e.label, `options[${i}].label`, LIMITS.labelChars);
    if (!label.ok) return label;
    const hint = optStr(e.hint, `options[${i}].hint`, LIMITS.hintChars);
    if (!hint.ok) return hint;
    options.push({
      value: value.value,
      label: label.value ?? value.value,
      hint: hint.value,
    });
  }

  return {
    ok: true,
    block: {
      kind: "choice",
      id: id.value,
      prompt: prompt.value,
      multiple: o.multiple === true,
      options,
    },
  };
}

function parseSecret(o: Record<string, unknown>): UiBlockResult {
  const name = reqStr(o.name, "name", LIMITS.secretNameChars);
  if (!name.ok) return name;
  if (!SECRET_NAME.test(name.value)) return fail("name has illegal characters");
  const why = optStr(o.why, "why", LIMITS.whyChars);
  if (!why.ok) return why;
  return { ok: true, block: { kind: "secret", name: name.value, why: why.value } };
}
