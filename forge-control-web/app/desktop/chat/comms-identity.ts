/**
 * comms-identity.ts — who a transcript line is FROM, and what colour that is.
 *
 * Konrad, 2026-08-16, reading the manager chat: "pls colorcode the messages
 * from the builders in this chat so I can faster distinguish."
 *
 * The reason they were indistinguishable is structural, not cosmetic. A worker
 * report arrives through `POST /api/runs/:id/message` and is appended as
 * `role: "user"` — deliberately, so both prompt builders deliver it unchanged
 * (forge-control/src/lib/run-control-rules.ts:459). So in the transcript it
 * rendered as an ordinary right-aligned user bubble: byte-identical treatment
 * to something Konrad typed himself. The only thing separating them is
 * `meta.comms`, which nothing on the client read until this round.
 *
 * ── EVERY FIELD HERE COMES OFF THE WIRE ───────────────────────────────────
 * `meta.comms` is written by `commsEntries` and carries `{ direction, from,
 * peer_run_id, peer_role?, subagent_id? }`. `peer_role` is round 808's
 * addition, stamped server-side from the SENDER RUN's `metadata.role` at write
 * time — so attribution survives a full-transcript rebuild exactly the way the
 * in-band `[message from worker abc12345]` label does.
 *
 * MESSAGES WRITTEN BEFORE THAT STAMP EXISTED HAVE NO `peer_role`, and there
 * are 19 of them in Konrad's current chat alone. For those the renderer passes
 * a `peers` map built from the team panel's ALREADY-POLLED `["chat-team", id]`
 * cache (AssistantThread → ChatSurface). That map is a fallback, never a
 * source of truth that outranks the stamp, and when neither has an answer the
 * row says `unknown role` rather than guessing one. No fetch is added by any
 * of this — see AssistantThread's `peers` prop.
 *
 * Pure, React-free, dependency-free: `scripts/checks/check-chat-rich.ts`
 * imports it directly under tsx.
 */

import { tokens } from "../../tokens";
import { roleTokenName, type RoleTokenName } from "../live/agentsApi";

/** Who sent it, in the server's vocabulary (`COMMS_FROM`). */
export type CommsFrom = "konrad" | "manager" | "worker";

/** `in` — this run RECEIVED it. `out` — this run SENT it and is holding the
 *  echo. The manager chat holds both, which is exactly what makes the
 *  direction marker load-bearing rather than decoration. */
export type CommsDirection = "in" | "out";

export interface CommsFacts {
  direction: CommsDirection;
  from: CommsFrom;
  /** The OTHER end: the sender for `in`, the target for `out`. Null when the
   *  sender had no run of its own (Konrad messaging from the UI). */
  peerRunId: string | null;
  /** The peer run's `metadata.role`, stamped at write time. Null on every
   *  entry written before round 808 and on any peer with no role. */
  peerRole: string | null;
  /** Present only on a relay addressed at a sub-agent (C10). */
  subagentId: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

const FROM: ReadonlySet<string> = new Set(["konrad", "manager", "worker"]);

/**
 * Read `meta.comms` off a thread entry's meta. Total over `unknown`: this runs
 * on the render path of every message in a 600-entry thread, and a malformed
 * meta must degrade to "not a comms entry" (i.e. today's plain rendering),
 * never throw the transcript away.
 *
 * A `direction` or `from` outside the server's vocabulary is REJECTED rather
 * than defaulted. Defaulting would let a malformed entry borrow a worker's
 * identity, and the whole point of this module is that identity is asserted by
 * the server, not inferred by the renderer.
 */
export function readComms(meta: unknown): CommsFacts | null {
  if (typeof meta !== "object" || meta === null) return null;
  const raw = (meta as Record<string, unknown>).comms;
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const direction = c.direction;
  const from = c.from;
  if (direction !== "in" && direction !== "out") return null;
  if (typeof from !== "string" || !FROM.has(from)) return null;
  return {
    direction,
    from: from as CommsFrom,
    peerRunId: str(c.peer_run_id),
    peerRole: str(c.peer_role),
    subagentId: str(c.subagent_id),
  };
}

/* ── Roles ────────────────────────────────────────────────────────────────
 *
 * The eight roles the fleet can spawn. Six of them are the panel's
 * (`agentsApi.ROLE_TOKEN`); `steward` and `tester` exist as agent types but
 * have never had a row, so the panel has no colour for them and this map adds
 * one rather than dropping them into the same grey as "unknown".
 */

export const TRANSCRIPT_ROLES = [
  "architect",
  "planner",
  "builder",
  "reviewer",
  "researcher",
  "scout",
  "steward",
  "tester",
] as const;

export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

/** The tint + ink pair a row wears. Both are `var(--fg-*)` strings; nothing
 *  here is ever a literal colour (NFU1, and the no-raw-colours gate). */
export interface RoleIdentity {
  /** The role as stored, or null when nobody could name it. */
  role: string | null;
  /** What the header prints. `unknown role` when there is none — an honest
   *  word, not a blank that reads as "manager prose". */
  label: string;
  /** Card tint. */
  bg: string;
  /** Header text and the left accent rule — ONE hue per role, so a rule can
   *  never disagree with the label it sits beside. */
  ink: string;
}

const IDENTITY: Record<TranscriptRole, { bg: string; ink: string }> = {
  architect: { bg: tokens.roleBgArchitect, ink: tokens.roleInkArchitect },
  planner: { bg: tokens.roleBgPlanner, ink: tokens.roleInkPlanner },
  builder: { bg: tokens.roleBgBuilder, ink: tokens.roleInkBuilder },
  reviewer: { bg: tokens.roleBgReviewer, ink: tokens.roleInkReviewer },
  researcher: { bg: tokens.roleBgResearcher, ink: tokens.roleInkResearcher },
  scout: { bg: tokens.roleBgScout, ink: tokens.roleInkScout },
  steward: { bg: tokens.roleBgSteward, ink: tokens.roleInkSteward },
  tester: { bg: tokens.roleBgTester, ink: tokens.roleInkTester },
};

const UNKNOWN: RoleIdentity = {
  role: null,
  label: "unknown role",
  bg: tokens.roleBgUnknown,
  ink: tokens.roleInkUnknown,
};

/**
 * Which panel token a role's ink is DERIVED from. This is not used to pick a
 * colour — theme.css already points `--fg-roleInk*` at these — it exists so
 * `check-chat-rich.ts` can assert the two agree for the six roles the panel
 * also colours. A future hand that repoints one and forgets the other fails
 * that check instead of shipping two blues for the same builder.
 *
 * `scout` deliberately differs from `roleTokenName("scout")`: see theme.css.
 *
 * Typed as the token NAME (a plain string), not as `RoleTokenName`: `stuck`
 * and `bleed` are real tokens but are not in that union, because the union
 * describes the panel's six roles and this map describes eight.
 */
export const ROLE_INK_SOURCE: Record<TranscriptRole, string> = {
  architect: "decide",
  planner: "info",
  builder: "accent",
  reviewer: "warn",
  researcher: "ok",
  scout: "textMuted",
  steward: "stuck",
  tester: "bleed",
};

/** The six roles whose ink MUST equal what the Live rail and team panel use.
 *  `steward`/`tester` are absent from ROLE_TOKEN, and `scout` is the AA
 *  deviation theme.css documents. */
export const ROLE_INK_SHARED_WITH_PANEL: readonly TranscriptRole[] = [
  "architect",
  "planner",
  "builder",
  "reviewer",
  "researcher",
];

/** True when `roleTokenName` would give this role the same hue family this
 *  module does — the invariant `check-chat-rich.ts` asserts. */
export function inkAgreesWithPanel(role: TranscriptRole): boolean {
  return ROLE_INK_SOURCE[role] === roleTokenName(role);
}

function isTranscriptRole(role: string): role is TranscriptRole {
  return (TRANSCRIPT_ROLES as readonly string[]).includes(role);
}

/**
 * Colour identity for a role string. An UNSEEN role (a new agent type nobody
 * has taught this map about) keeps its own name in the label and takes the
 * neutral tint — visible as itself, never silently relabelled as something
 * this file does know.
 */
export function roleIdentity(role: string | null | undefined): RoleIdentity {
  const name = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (!name) return UNKNOWN;
  if (!isTranscriptRole(name)) return { ...UNKNOWN, role: name, label: name };
  return { role: name, label: name, ...IDENTITY[name] };
}

/* ── The in-band label ────────────────────────────────────────────────────
 *
 * `commsEntries` writes the sender into the CONTENT as well as the meta:
 *
 *   in       `[message from worker c8bc5ffa] …`
 *   relay    `[relay from manager 1a2b3c4d -> sub-agent toolu_01…] Deliver …`
 *   out      `[to worker 4e842cc8] …`
 *
 * That is on purpose (run-control-rules.ts:401) — it survives a full-transcript
 * rebuild after a resume-miss. The card renders the same fact as a header, so
 * the prefix is lifted OUT of the body rather than shown twice. It is returned,
 * not discarded: a prefix this parser does not recognise stays in the body,
 * where Konrad can see it, instead of being eaten.
 */

const PREFIX = /^\[(message from|relay from|to)\s+([^\]]*)\]\s*/;

export interface StrippedContent {
  /** The bracketed label exactly as it appeared, or null when there was none. */
  prefix: string | null;
  /** Everything after it. Never trimmed beyond the one space the label ate —
   *  a report's own leading blank lines are its author's formatting. */
  body: string;
}

export function stripCommsPrefix(content: string): StrippedContent {
  if (typeof content !== "string") return { prefix: null, body: "" };
  const m = PREFIX.exec(content);
  if (!m) return { prefix: null, body: content };
  return { prefix: m[0].trimEnd(), body: content.slice(m[0].length) };
}

/** First 8 characters of a run uuid — the id every log line, every `[message
 *  from …]` label and the team panel already print. Null in, em dash out. */
export function shortRunId(id: string | null | undefined): string {
  if (typeof id !== "string" || id === "") return "—";
  return id.slice(0, 8);
}

/* ── The one-line preview (round 1871) ────────────────────────────────────
 *
 * The customer test, on 117 of these cards: "a wall of text … 0 collapse
 * controls … full payload always expanded — directly above Bash rows that
 * collapse to one line with `done ▸`". The card needs the same grammar the
 * tool row has: a line you can skim, and a payload you ask for.
 *
 * This is that line. It is derived from the SAME body string the expanded card
 * renders — no second source, nothing fetched — and it is deliberately dumb
 * about markdown: the first line of prose, with the syntax that would render as
 * decoration stripped so a report beginning `## Phase 800 planned` previews as
 * `Phase 800 planned` rather than as two hashes.
 */

/** Markdown that is structure rather than words, at the START of a line. */
const LEADING_SYNTAX = /^\s*(?:[#>]+\s*|[-*+]\s+|\d+[.)]\s+|```[\w-]*\s*)/;

export const COMMS_PREVIEW_CHARS = 120;

/**
 * The collapsed card's one-liner.
 *
 * Takes the first line that has words in it, so a report that opens with a
 * fence or a blank line still previews its actual first sentence. Truncation is
 * on a character budget with a real ellipsis; the full text is one click away
 * and is never modified by this function.
 *
 * Pure and total: any input, including an empty body, produces a string.
 */
export function commsPreview(body: string, limit = COMMS_PREVIEW_CHARS): string {
  if (typeof body !== "string") return "(empty)";
  for (const raw of body.split("\n")) {
    const line = raw.replace(LEADING_SYNTAX, "").trim();
    if (line === "") continue;
    // Inline emphasis is noise in a 120-character skim line, and stripping the
    // markers never changes which WORDS appear.
    const flat = line.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
    if (flat === "") continue;
    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
  }
  return "(empty)";
}

/* ── The header line ──────────────────────────────────────────────────────── */

/** What the caller knows about a peer run, beyond its role. Supplied from the
 *  team panel's already-polled cache; never fetched by this module. */
export interface PeerFacts {
  role: string | null;
  /** The worker's task title — "Fix cycle 1", "Phase 1 gating review". This is
   *  the NAME a human would use for that agent, and round 1871 puts it in the
   *  card header in place of eight hex characters. */
  description: string | null;
}

export interface CommsHeader {
  /** `◂` received, `▸` sent. A glyph, not an icon dependency (NFU8). */
  arrow: string;
  /** "from" / "to" — the word beside the arrow. */
  preposition: string;
  /** "worker" / "manager" / "konrad" — WHAT the peer is. */
  actor: CommsFrom;
  /** Role name, or "unknown role". */
  role: string;
  /** 8-char peer run id, or the em dash. */
  peer: string;
  /** WHO this is, in as many words as anybody could supply: the peer's task
   *  title when the team cache knows it, else its role, else its short id,
   *  else the actor word. Round 1871 — the collapsed card leads with this, and
   *  `peer` moves to the tooltip, because "c8bc5ffa · unknown role" is not a
   *  name and Konrad said so. Never empty. */
  name: string;
  /** Set when this line is a relay addressed at a sub-agent. */
  subagent: string | null;
  identity: RoleIdentity;
  /** The whole line as one string, for the row's `title` and for tests. */
  summary: string;
}

/**
 * Everything the card's header prints, resolved once.
 *
 * `resolvedRole` is the caller's fallback (the team-panel cache); the STAMP
 * wins whenever it exists. Konrad and manager peers are not given a role at
 * all — "konrad" is not an agent type, and a manager's role is `manager`,
 * which is not in this map and would print as itself. Both are correct
 * without inventing anything.
 */
export function commsHeader(
  facts: CommsFacts,
  resolved?: string | PeerFacts | null,
): CommsHeader {
  /* The fallback used to be a bare role string and several callers still pass
   * one. Both shapes are accepted rather than forcing a migration on a check
   * script that only ever knew about roles. */
  const peerFacts: PeerFacts =
    typeof resolved === "string"
      ? { role: resolved, description: null }
      : (resolved ?? { role: null, description: null });
  const role = facts.peerRole ?? peerFacts.role ?? null;
  const identity = roleIdentity(facts.from === "konrad" ? null : role);
  const arrow = facts.direction === "in" ? "◂" : "▸";
  const preposition = facts.direction === "in" ? "from" : "to";
  const peer = shortRunId(facts.peerRunId);
  /* Best available name, in descending order of how much it tells a reader.
   * Konrad is named by the one word that is always right for him. */
  const name =
    facts.from === "konrad"
      ? "konrad"
      : (peerFacts.description ??
        (identity.role !== null ? identity.label : null) ??
        (peer !== "—" ? peer : facts.from));
  /* "◂ from worker · builder · c8bc5ffa" — actor, role, id, in that order,
   * because that is the order the eye needs them: what it is, what it does,
   * which one it was. Konrad gets no role segment; he is not an agent. */
  const summary = [
    `${arrow} ${preposition} ${facts.from}`,
    facts.from === "konrad" ? null : identity.label,
    peer === "—" ? null : peer,
    facts.subagentId ? `→ sub-agent ${facts.subagentId}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return {
    arrow,
    preposition,
    actor: facts.from,
    role: identity.label,
    peer,
    name,
    subagent: facts.subagentId,
    identity,
    summary,
  };
}

/* ── The ledger: what THIS transcript holds of the traffic ────────────────────
 *
 * Round 1873, finding 6. DoD 4 asks for "messages the operator sends to agents
 * and results it receives back" as first-class blocks. Round 1871 shipped the
 * card; the tester then counted 119 cards in the operator chat and found every
 * single one `direction="in"`, which is not a rendering bug — it is what the
 * data says. The reciprocal records exist, on the WORKERS' threads, because of
 * where `commsEntries` writes them (forge-control/src/lib/run-control-rules.ts):
 *
 *   · the RECEIVER's thread always gets the `in` entry;
 *   · the SENDER's thread gets the `out` echo ONLY IF the sender is a run —
 *     `if (!senderRunId) return { receiver, echo: null }`.
 *
 * A worker reports up with `sender_run_id=$FORGE_RUN_UUID`, so it keeps an `out`
 * echo of its own report and the manager holds the matching `in`. The operator
 * chat's own traffic downward is not written through that route at all — it
 * starts projects (`POST /api/projects`) and the engine seeds the tasks — so
 * there is no `out` entry to render here, and there is no client fix for that:
 * the payload does not exist. Measured on 2026-08-17 against the live `runs`
 * table: 123 `out` entries across 103 runs fleet-wide, 0 of them on chat
 * `bfd1283a`, whose 120 comms entries are all `in`.
 *
 * The brief's instruction for exactly this case is "document exactly what is
 * missing instead of building new plumbing". The census below is that
 * documentation, rendered in the transcript where the reader is counting cards
 * rather than in a file nobody opens.
 */

/** How many relayed messages this thread holds, by direction. */
export interface CommsCensus {
  in: number;
  out: number;
}

const NO_COMMS: CommsCensus = { in: 0, out: 0 };

/**
 * Count the comms entries in a thread.
 *
 * Total over `unknown[]`: it reads the same `meta.comms` the cards do, through
 * the same `readComms` validator, so a card that renders and an entry that
 * counts are the same set by construction — a census derived from a looser test
 * would eventually disagree with the cards it is describing.
 */
export function commsCensus(
  thread: readonly { meta?: unknown }[] | null | undefined,
): CommsCensus {
  if (!thread || thread.length === 0) return NO_COMMS;
  let inbound = 0;
  let outbound = 0;
  for (const entry of thread) {
    const facts = readComms(entry.meta);
    if (facts === null) continue;
    if (facts.direction === "in") inbound += 1;
    else outbound += 1;
  }
  return inbound === 0 && outbound === 0 ? NO_COMMS : { in: inbound, out: outbound };
}

/** The one line the transcript prints, or null when there is no traffic to
 *  describe (most runs) and therefore nothing to say. */
export function commsLedgerLine(c: CommsCensus): string | null {
  if (c.in === 0 && c.out === 0) return null;
  const parts = [`${c.in} received`, `${c.out} sent`];
  if (c.out === 0) {
    parts.push("this run holds no outbound records — see the tooltip");
  }
  return `AGENT COMMS · ${parts.join(" · ")}`;
}

/** The long form, on hover. States the mechanism rather than the symptom, so a
 *  reader who wants to check it knows where to look. */
export function commsLedgerTitle(c: CommsCensus): string {
  const counted =
    `This transcript holds ${c.in} inbound and ${c.out} outbound relayed ` +
    `message${c.out === 1 ? "" : "s"}, each rendered as one collapsible card.`;
  if (c.out > 0) {
    return (
      `${counted} “received” is a message this run was sent; “sent” is the echo ` +
      `of one it sent to someone else.`
    );
  }
  return (
    `${counted} There is no outbound half to show, and that is a property of the ` +
    `DATA, not of this view: an echo is only written to a sender that has a run ` +
    `of its own (commsEntries in forge-control/src/lib/run-control-rules.ts). ` +
    `Messages this operator sent DOWN to an agent are recorded on that agent's ` +
    `own thread — open the worker from the team panel and its transcript shows ` +
    `them as “sent” cards. Nothing is being hidden here; nothing was written.`
  );
}
