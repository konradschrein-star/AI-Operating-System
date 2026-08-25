/** WHICH ENGINE is running a row — the badge, as data.
 *
 *  Pure and React-free on purpose, like ./teamRows and ./liveSessions: it
 *  yields a token NAME, never a colour, and `./LiveSessionsStrip` is the only
 *  place a name becomes a `tokens.*` value. That is the same split
 *  ../live/agentsApi makes with `roleTokenName`, and it is what lets
 *  `scripts/checks/check-live-sessions.ts` assert the map under tsx without a
 *  DOM.
 *
 *  ── THERE IS NO CODEX ────────────────────────────────────────────────────────
 *  Konrad's sentence was "the claude/agy/codex sessions". Two of those three
 *  exist. `grep -rn codex forge-control/src` finds nothing: the executor
 *  dispatches to the Claude CLI (`claude-code`) or to Gemini via agy (`agy`),
 *  and there is no third branch. A codex badge would put a lie on his screen
 *  and, worse, one no row could ever be checked against. So the map ships the
 *  two engines that exist — and it is a MAP, so the day a third lands it is one
 *  entry here plus nothing anywhere else.
 *
 *  ── WHERE THE STRING COMES FROM, AND WHY NOT `metadata.engine` ──────────────
 *  The server derives it from the MODEL (`badgeEngineForModel` in
 *  forge-control/src/lib/team-live.ts), which defers to the dispatcher's own
 *  `isGeminiModel`. `runs.metadata.engine` answers a different question —
 *  which dispatch branch was taken — and over the seven days to 2026-08-25, 46
 *  rows pair `engine = 'claude-code'` with a Gemini model. A badge fed from
 *  that column is wrong on every one of them.
 */

/** Token NAMES, not values — see the header. Kept to identity colours: the
 *  status tokens belong to the status dot, and an engine that borrowed one
 *  would read as a state. */
export type EngineTokenName = "accent" | "decide" | "textMuted" | "textGhost";

export interface EngineBadge {
  /** What the badge prints. Short: it is the first column of a 260px panel. */
  label: string;
  /** Which token the label wears. */
  tokenName: EngineTokenName;
  /** The native `title`. Always names the RAW engine string, because the label
   *  is an abbreviation and the tooltip is the diagnostic surface. */
  title: string;
  /** `data-engine` on the element — the raw string for a known or unknown
   *  engine, `"none"` when there is nothing to name. Lets a check harness and a
   *  reviewer read what a row claims without trusting the pixels. */
  attr: string;
  /** False for the two gap cases, so a caller can style "no answer" without
   *  string-matching the label. */
  known: boolean;
}

/** Rendered wherever there is no honest value — the same glyph the rest of the
 *  panel uses. */
const EM_DASH = "—";

/**
 * THE MAP. One entry per engine that exists in this system.
 *
 * Keyed by the exact string the server sends, which is `engineForModel`'s
 * output and therefore one of a closed set on the server side — but typed
 * `Record<string, …>` here, because a client must treat a server's vocabulary
 * as data. An engine not in this map is not an error; it is a newer server,
 * and `engineBadge` renders its raw string rather than pretending.
 */
export const ENGINE_BADGE: Record<string, EngineBadge> = {
  "claude-code": {
    label: "claude",
    tokenName: "accent",
    title:
      "claude-code — this row is a Claude CLI session. Derived from the model, " +
      "not from metadata.engine: that column records which dispatch branch ran " +
      "and is wrong on the rows left by the 2026-08-24 engine-key collision.",
    attr: "claude-code",
    known: true,
  },
  agy: {
    label: "agy",
    tokenName: "decide",
    title:
      "agy — this row is a Gemini session driven through the agy CLI. Derived " +
      "from the model via the dispatcher's own isGeminiModel predicate, so the " +
      "badge cannot drift from the routing it describes.",
    attr: "agy",
    known: true,
  },
};

/** An engine string this client has never heard of. Prints ITS OWN RAW STRING
 *  in a neutral token — the honest rendering of "a newer server is running an
 *  engine this console predates". Never a defaulted claude badge. */
function unknownEngine(engine: string): EngineBadge {
  return {
    label: engine,
    tokenName: "textMuted",
    title:
      `${engine} — an engine this console does not have a badge for. The raw ` +
      "string is shown as-is rather than guessed at; adding it is one entry in " +
      "ENGINE_BADGE (app/desktop/team/engineBadge.ts).",
    attr: engine,
    known: false,
  };
}

/** The two ways there is nothing to badge, told apart in words.
 *
 *  `gap` mirrors `FieldGap` in ./liveSessions and is passed rather than
 *  inferred, because this module cannot see the difference from `null` alone —
 *  and the difference is the whole reason `engine` ships as an optional field. */
const NO_ENGINE_UNKNOWN: EngineBadge = {
  label: EM_DASH,
  tokenName: "textGhost",
  title:
    "engine not derivable — this row's model was never recorded, and the " +
    "server refuses to default an unmeasured model to Claude. Not claude: unknown.",
  attr: "none",
  known: false,
};

const NO_ENGINE_NOT_SERVED: EngineBadge = {
  label: EM_DASH,
  tokenName: "textGhost",
  title:
    "engine not reported — this console is newer than the API answering it, " +
    "and that response carries no engine field at all. Nothing was measured " +
    "and nothing is being claimed.",
  attr: "none",
  known: false,
};

/**
 * The badge for an engine string, or for the absence of one.
 *
 * `null`/`undefined` NEVER produces a claude badge. `engineForModel(null)`
 * returns `"claude-code"` on the server and is right to — for DISPATCH an
 * unknown model must never silently become Gemini — but for a badge that same
 * default asserts a fact nobody measured, and it is indistinguishable from a
 * row that really is Claude. So the gap renders the em dash and says which gap
 * it is.
 */
export function engineBadge(
  engine: string | null | undefined,
  gap: "not-served" | "unknown" | null,
): EngineBadge {
  if (engine === null || engine === undefined || engine === "") {
    return gap === "not-served" ? NO_ENGINE_NOT_SERVED : NO_ENGINE_UNKNOWN;
  }
  return ENGINE_BADGE[engine] ?? unknownEngine(engine);
}
