/**
 * browser-shots.ts — "which UI did you actually look at?", answered from the
 * transcript. Round 1350, PHASE 6 item 2 (client half).
 *
 * Pure, React-free, dependency-free, and it NEVER THROWS: every entry point
 * returns `[]` (or `null`) on anything it does not recognise. It runs inside
 * the render path of every tool row in a 300-entry transcript, so a malformed
 * payload must cost a wasted regex, not a blank chat.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT MARKDOWN, AND MUST NEVER BECOME MARKDOWN
 * ═══════════════════════════════════════════════════════════════════════════
 * `rehype-forge-allowlist.ts` turns EVERY markdown image into inert text. Read
 * its header: that was a real beacon hole — an agent that has read a hostile
 * page writes the message this console renders, and `![x](http://attacker/…)`
 * made the console fetch an attacker-chosen URL from Konrad's IP the moment he
 * opened the chat. It was closed on purpose and it stays closed.
 *
 * Screenshots therefore do NOT travel as markdown. They travel as STRUCTURED
 * data: this module reads the tool-call/tool-result payloads the mapping layer
 * already produced, extracts a 12-hex directory id and a filename, VALIDATES
 * both against fixed character classes, and `shotSrc()` builds the URL itself
 * from those two validated pieces. No attacker-supplied string ever reaches an
 * `src` — the only thing an agent's output can influence is *which file under
 * /opt/ai-os/uploads/<12hex>/ is shown*, and every one of those was written by
 * this machine. A future reader tempted to "just re-enable images in the
 * allowlist": don't. The allowlist and this file are two halves of one
 * decision.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO SHAPES IT READS
 * ═══════════════════════════════════════════════════════════════════════════
 * (a) A `Bash` tool_result from `scripts/research-browser.mjs`, which prints a
 *     JSON status carrying `screenshots: [{ label, path, url, url_servable }]`
 *     (research-browser.mjs:306 `screenshotRecord`).
 *
 *     NOT parsed as JSON, and that is deliberate rather than lazy. The real
 *     captured fixture (run 7a0c6432, entry 121) is the operator piping the
 *     tool through `grep -A3 '"path"'` — three lines of a JSON object, brace
 *     unbalanced, `JSON.parse` hopeless. What survives every such mangling is
 *     the RECORD SHAPE: a `"url"` member whose value is
 *     `/api/uploads/<12hex>/<name>`. That is what this matches — the shape, not
 *     prose. A result that merely mentions `/api/uploads` in a sentence has no
 *     such member and yields nothing (asserted in check-browser-shots.ts).
 *
 * (b) A `Read` tool_call whose `file_path` is under `/opt/ai-os/uploads/<12hex>/`
 *     — the operator opening a shot to look at it. Note this also catches an
 *     image Konrad ATTACHED to the chat (POST /api/uploads writes into the same
 *     tree with the same id shape); `source: "read"` is what distinguishes the
 *     two provenances, and the UI says "images" rather than "screenshots" when
 *     any ref came in that way. See docs/plan/artifacts/phase1350/browser-visibility.md.
 */

/** The uploads route's own gate: `/^[a-f0-9]{12}$/`, 400 for anything else
 *  (forge-control/src/routes/uploads.ts:24). Never weaken it. */
const DIR_ID_RE = /^[a-f0-9]{12}$/;

/**
 * A filename we are willing to put in a URL. Deliberately NARROWER than the
 * server's `safeName`, which rewrites offending characters to `_`: rewriting
 * here would produce a URL for a file that does not exist under that name, so
 * anything outside this class is dropped instead.
 */
const SHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,119}$/;

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;

/** `20260805T101530Z-perplexity-login-wall.png` → stamp + label.
 *  Same convention as forge-control/src/lib/uploads-index.ts:23. */
const STAMPED_NAME_RE = /^(\d{8}T\d{6}Z)-(.+)\.[A-Za-z0-9]+$/;

/** A `"url": "/api/uploads/<12hex>/<name>"` member, however mangled its
 *  surroundings. `[^"\\]` rather than `.`: a JSON escape inside the value means
 *  this is not a plain filename and we want no part of it. */
const URL_MEMBER_RE = /"url"\s*:\s*"\/api\/uploads\/([a-f0-9]{12})\/([^"\\/]{1,140})"/g;

/** `"file_path": "…"` — the salvage path for a `Read` whose args are not
 *  parseable JSON (a clipped payload). */
const FILE_PATH_MEMBER_RE = /"file_path"\s*:\s*"([^"\\]{1,300})"/;

const UPLOADS_PATH_RE = /^\/opt\/ai-os\/uploads\/([a-f0-9]{12})\/([^/]{1,140})$/;

/** Where this file's screenshots are proxied from — the same `/api/proxy`
 *  rewrite every other client call goes through (app/api.ts:22,
 *  next.config.mjs). */
const PROXY_ROOT = "/api/proxy";

export interface BrowserShotRef {
  /** The 12-hex uploads directory — a run's `uploadsRunId`. Validated. */
  dirId: string;
  /** Bare filename, validated against SHOT_NAME_RE. */
  name: string;
  /** The forge-control path that serves it. Built here from the two validated
   *  pieces, never lifted verbatim out of the payload. `shotSrc()` is what the
   *  browser actually loads; this field is the greppable server-side form. */
  url: string;
  /** Human label — the convention's `<label>` segment, else the bare stem. */
  label: string;
  /** The shot's own time, ISO-8601 UTC, parsed from the filename stamp. Null
   *  when the name carries no stamp (a chat attachment, `image.png`). */
  ts: string | null;
  source: "bash" | "read";
}

/** What the mapping layer hands a tool row (thread-mapping.ts `ToolCallPart`),
 *  reduced to the three fields this module reads. Structural on purpose — the
 *  check script builds these from a raw thread without importing React. */
export interface ToolCallLike {
  toolName: string;
  argsText?: string;
  result?: unknown;
}

/**
 * A run id in its uploads-directory form: the first 12 hex characters of the
 * run UUID.
 *
 * MIRRORS `uploadsRunId` in forge-control/src/lib/cc-runner.ts:138 — the
 * producer of the convention. It is re-derived here rather than imported
 * because engine internals are owned by another project this cycle and this
 * one may not touch that file; the assertion
 * `"ece63bdb-1f2a-4c3d-9e8f-0a1b2c3d4e5f" → "ece63bdb1f2a"` is copied from
 * cc-runner.test.ts:80 into check-browser-shots.ts so the two stay pinned to
 * each other. If that assertion ever fails, the convention moved and this file
 * is wrong, not the test.
 *
 * Differs from the engine's version in exactly one way: it returns `null`
 * where cc-runner throws. The engine is DECIDING a directory and must fail
 * loudly; this is a renderer LOOKING one up, and a row with an unusable id
 * simply has no screenshots to show.
 */
export function uploadsDirId(runId: string | null | undefined): string | null {
  if (typeof runId !== "string") return null;
  const hex = runId.toLowerCase().replace(/[^a-f0-9]/g, "");
  if (hex.length < 12) return null;
  return hex.slice(0, 12);
}

/** `20260817T032357Z` → `2026-08-17T03:23:57Z`. Null for anything else. */
export function stampToIso(stamp: string | null): string | null {
  if (stamp === null || !/^\d{8}T\d{6}Z$/.test(stamp)) return null;
  const d = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const t = `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
  return `${d}T${t}Z`;
}

/** `20260817T032357Z-settings-dark.png` → `03:23:57` (UTC, no locale).
 *  Formatted from the STAMP, not from `Date#toLocaleTimeString`: this renders
 *  during SSR as well as in the browser and a locale-dependent string there is
 *  a hydration mismatch. */
export function shotClock(ts: string | null): string {
  if (ts === null || ts.length < 20) return "";
  return ts.slice(11, 19);
}

export interface ParsedShotName {
  label: string;
  ts: string | null;
}

/** Convention first, honest fallback second. Never throws. */
export function parseShotName(name: string): ParsedShotName {
  const m = STAMPED_NAME_RE.exec(name);
  if (m) return { label: m[2], ts: stampToIso(m[1]) };
  return { label: name.replace(IMAGE_EXT_RE, "") || name, ts: null };
}

/**
 * THE ONLY PLACE A SCREENSHOT URL IS BUILT. Both pieces are re-validated here
 * even though every caller validated them already — this function is the
 * security boundary, and a boundary that trusts its callers is not one.
 * Returns null rather than a half-built URL.
 */
export function shotSrc(dirId: string, name: string): string | null {
  if (!DIR_ID_RE.test(dirId)) return null;
  if (!SHOT_NAME_RE.test(name) || !IMAGE_EXT_RE.test(name)) return null;
  return `${PROXY_ROOT}/uploads/${dirId}/${encodeURIComponent(name)}`;
}

function makeRef(
  dirId: string,
  rawName: string,
  source: "bash" | "read",
): BrowserShotRef | null {
  if (!DIR_ID_RE.test(dirId)) return null;
  const name = rawName.trim();
  if (!SHOT_NAME_RE.test(name) || !IMAGE_EXT_RE.test(name)) return null;
  const { label, ts } = parseShotName(name);
  return {
    dirId,
    name,
    url: `/api/uploads/${dirId}/${encodeURIComponent(name)}`,
    label,
    ts,
    source,
  };
}

/** `Read`'s `file_path`, from JSON when it parses and from the member regex
 *  when it does not. */
function readFilePath(argsText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed !== null && typeof parsed === "object") {
      const fp = (parsed as Record<string, unknown>).file_path;
      if (typeof fp === "string") return fp;
    }
  } catch {
    /* Clipped or wrapped payload — fall through to the shape match, which is
     * the same tactic the Bash path uses and for the same reason. */
  }
  const m = FILE_PATH_MEMBER_RE.exec(argsText);
  return m ? m[1] : null;
}

/**
 * Every screenshot this tool call touched, in payload order, deduplicated by
 * `<dirId>/<name>` (a research-browser run prints its record on stdout AND in
 * the status block, and the reader wants one thumbnail, not two).
 *
 * Never throws. Anything unrecognised yields `[]`.
 */
export function extractBrowserShots(call: ToolCallLike): BrowserShotRef[] {
  const out: BrowserShotRef[] = [];
  const seen = new Set<string>();
  const push = (ref: BrowserShotRef | null): void => {
    if (ref === null) return;
    const key = `${ref.dirId}/${ref.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  const tool = typeof call.toolName === "string" ? call.toolName : "";

  if (tool === "Bash" || tool === "bash") {
    const result = typeof call.result === "string" ? call.result : null;
    if (result !== null && result.length > 0) {
      /* `lastIndex` is per-call state on a module-level /g regex; reset it so
       * one row's scan can never start mid-string because of the previous. */
      URL_MEMBER_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_MEMBER_RE.exec(result)) !== null) {
        push(makeRef(m[1], m[2], "bash"));
      }
    }
    return out;
  }

  if (tool === "Read" || tool === "read") {
    const args = typeof call.argsText === "string" ? call.argsText : null;
    if (args === null || args.length === 0) return out;
    const filePath = readFilePath(args);
    if (filePath === null) return out;
    const m = UPLOADS_PATH_RE.exec(filePath);
    if (m) push(makeRef(m[1], m[2], "read"));
    return out;
  }

  return out;
}

/**
 * The collapsed line's noun. "screenshots" is a claim about PROVENANCE — that
 * the browser tool took them — and it is only true of `source: "bash"` refs. A
 * `Read` of `/opt/ai-os/uploads/<id>/image.png` may equally be an attachment
 * Konrad dropped into the chat, so a mixed or read-only set says "images".
 */
export function shotsNoun(refs: readonly BrowserShotRef[]): string {
  const allBash = refs.length > 0 && refs.every((r) => r.source === "bash");
  const noun = allBash ? "screenshot" : "image";
  return refs.length === 1 ? noun : `${noun}s`;
}

/** Newest first by stamp; unstamped refs keep payload order at the end. */
export function newestFirst(refs: readonly BrowserShotRef[]): BrowserShotRef[] {
  return [...refs].sort((a, b) => {
    if (a.ts === null && b.ts === null) return 0;
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    return b.ts.localeCompare(a.ts);
  });
}
