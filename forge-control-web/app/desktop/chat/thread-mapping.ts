/**
 * runs.thread (flat ThreadEntry[]) → assistant-ui ThreadMessageLike[].
 *
 * Grouping rule: a consecutive run of assistant/tool/agent entries is ONE
 * assistant message whose content interleaves text parts and tool-call
 * parts (matching CC's actual turn structure). tool_result entries attach
 * to their tool-call part by tool_use_id. user/system entries are their
 * own messages; system carries `kind` in metadata.custom so the renderer
 * can color errors / stuck notices.
 *
 * ── Round 602: SCOPE, and the fold that makes a worker readable (U23) ─────
 * Until this round the mapper had no awareness of `meta.parent_tool_use_id`.
 * Sub-agent entries live INLINE in the parent run's thread, so a worker's
 * transcript interleaved its sub-agents' internals with its own prose — in run
 * 3853c154-e07b-4378-9313-2b34f4a33342, 196 of 285 entries belong to two
 * sub-agents, i.e. two thirds of what the reader saw was somebody else's work
 * attributed to the parent. That is precisely the confusion Konrad named.
 *
 * `opts.scope` picks whose story this is:
 *   "all"       — every entry, in thread order. THE DEFAULT, byte-identical to
 *                 the pre-602 output, so the manager chat and ProjectsSurface
 *                 do not change shape.
 *   "top-level" — the run's own entries only. A sub-agent's internals FOLD into
 *                 the Agent/Task tool-call part that spawned them.
 *   "subagent"  — one sub-agent's slice plus the envelope (the spawn call that
 *                 briefed it and the tool_result it reported back), which is
 *                 the whole story on older runs the executor never stamped.
 *
 * ── NOTHING IS DROPPED ────────────────────────────────────────────────────
 * Folding hides entries from a view; it must never lose them. `mapThreadView`
 * returns a `ThreadCoverage` that accounts for EVERY entry of the input thread
 * as exactly one of: visible here, folded into a spawn part on this view (one
 * descent away), or deeper (owned by a sub-agent that was not spawned at this
 * level — reachable, but more than one descent down). `coverage.ok` is that
 * arithmetic, and `scripts/checks/check-thread-mapping.ts` asserts it against
 * the real 285-entry capture.
 *
 * ── Message ids are thread indices, and they stay that way ────────────────
 * The walk iterates the WHOLE thread and skips what the scope excludes, rather
 * than filtering first. So `t7` is the eighth entry of the run in every scope,
 * which is what makes an id greppable against the API payload.
 */

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ThreadEntry } from "../../api";
import { readComms } from "./comms-identity";
import { parentToolUseId, spawnToolUseIds, subagentIndex, toolUseId } from "./subagent-slice";

/**
 * What a spawning Agent/Task tool-call part carries about the sub-agent whose
 * entries are folded underneath it. Derived only — every field is a count or a
 * wire value, nothing is fetched and nothing is invented.
 */
export type SubagentFold = {
  /** The spawn's `tool_use_id`. This IS `NavFrame.subagentId` — it is what
   *  601B's drill-in descends on, so the part carries it verbatim. */
  subagentId: string;
  /** Entries in this thread stamped `parent_tool_use_id === subagentId`.
   *  Zero is a real answer: the executor did not stamp older runs, so the
   *  sub-agent ran but none of its steps were written to the transcript. */
  eventCount: number;
  /** `ts` of the folded slice's first and last entry, in thread order. Null
   *  when the slice is empty or the executor wrote no timestamp. */
  firstTs: string | null;
  lastTs: string | null;
};

export type ToolCallPart = {
  type: "tool-call";
  toolCallId?: string;
  toolName: string;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  /** Present only on an Agent/Task call whose sub-agent is folded into it. */
  subagent?: SubagentFold;
};

type TextPart = { type: "text"; text: string };
type Part = TextPart | ToolCallPart;

/** Whose story a view tells. */
export type ThreadScope =
  | { kind: "all" }
  | { kind: "top-level" }
  | { kind: "subagent"; subagentId: string };

export interface MapThreadOptions {
  /** Defaults to `{ kind: "all" }` — the pre-602 behaviour. */
  scope?: ThreadScope;
}

/**
 * Where every entry of the input thread ended up. `visible + folded + deeper`
 * must equal `total`; `ok` says whether it does. A caller that renders past
 * `ok === false` is showing a transcript that lost entries.
 */
export interface ThreadCoverage {
  /** Entries handed in. */
  total: number;
  /** Entries this scope selected — the ones the view is responsible for. */
  visible: number;
  /**
   * Of `visible`, the entries that produced no message and no part: an
   * assistant turn whose content is empty, a `heartbeat`/`continue_marker`
   * whose role is "tool", a tool_result that attached to nothing and had no
   * text. PRE-602 BEHAVIOUR, unchanged — the walk has always skipped these.
   * It is counted rather than assumed away, because "visible" would otherwise
   * be a slightly generous word for it. On the round-600 capture this is the
   * run's heartbeats and nothing else.
   */
  silent: number;
  /** Entries folded into a spawn part on THIS view — one descent away. */
  folded: number;
  /** Entries belonging to the level ABOVE this one: the parent run's own
   *  entries as seen from inside a sub-agent's view. Reachable by pressing
   *  back, which is why they are not a loss — but they are not this view's,
   *  and counting them as "visible" would be the same overclaim the fold
   *  exists to remove. Always 0 for the `all` and `top-level` scopes. */
  above: number;
  /** Entries owned by a sub-agent not spawned at this level: reachable, but
   *  further than one descent. Zero on every thread observed so far (no run
   *  has yet nested a sub-agent inside a sub-agent) — counted anyway, because
   *  the day one does, it must show up as a number and not as a silent loss. */
  deeper: number;
  /** The `parent_tool_use_id`s behind `deeper`, in first-appearance order. */
  deeperParents: string[];
  /** `visible + folded + above + deeper === total`. */
  ok: boolean;
}

export interface ThreadView {
  messages: ThreadMessageLike[];
  coverage: ThreadCoverage;
}

const DEFAULT_SCOPE: ThreadScope = { kind: "all" };

/**
 * `role: "tool"` entries the walk skips ON PURPOSE, exhaustively listed.
 *
 * Everything else on that role — including a `kind` this client has never
 * heard of — degrades to a visible text part instead of vanishing (R20). The
 * list is the whitelist of deliberate silence; it is NOT "the kinds we know",
 * and adding a new kind to `ThreadEntry["kind"]` must not add it here unless
 * the intent really is to hide it.
 *
 *  - `heartbeat` / `continue_marker`: liveness and loop bookkeeping the
 *    executor writes for itself. Never transcript.
 *  - `error` / `stuck_notice`: the executor writes both on `role: "system"`,
 *    which is rendered as its own message with `kind` in metadata. On a tool
 *    role they are a duplicate of a system entry, so showing them would
 *    double the error in the reader's face.
 *  - `text`: prose belongs to an assistant/agent entry; on a tool role it is
 *    the pre-`kind` legacy shape and has never rendered.
 *  - `""`: a tool entry with no `kind` at all — the same legacy shape.
 */
const SILENT_TOOL_KINDS: ReadonlySet<string> = new Set([
  "heartbeat",
  "continue_marker",
  "error",
  "stuck_notice",
  "text",
  "",
]);

function entryDate(e: ThreadEntry): Date | undefined {
  const t = new Date(e.ts).getTime();
  return Number.isNaN(t) ? undefined : new Date(t);
}

/**
 * The envelope of a sub-agent view: the spawn `tool_call` that briefed it and
 * the `tool_result` it reported back, both carrying `meta.tool_use_id === id`
 * at the PARENT level. Mirrors `AgentChatView.subagentTranscript`, so handing
 * this mapper either the whole run's thread or the already-narrowed one it
 * synthesises yields the same view.
 */
function isEnvelopeOf(e: ThreadEntry, ownerId: string): boolean {
  return parentToolUseId(e) === null && toolUseId(e) === ownerId;
}

/**
 * Build the view. `mapThreadToMessages` is this without the accounting; the
 * accounting exists so the check script — and any future caller that cares —
 * can prove nothing was dropped.
 */
export function mapThreadView(
  thread: ThreadEntry[],
  opts?: MapThreadOptions,
): ThreadView {
  const scope = opts?.scope ?? DEFAULT_SCOPE;
  const ownerId = scope.kind === "subagent" ? scope.subagentId : null;

  /* One pass each, from round 601A's slicer — not a second reader of
   * `parent_tool_use_id` living in the renderer. */
  const index = scope.kind === "all" ? null : subagentIndex(thread);
  const spawnIds = scope.kind === "all" ? null : spawnToolUseIds(thread);

  const inScope = (e: ThreadEntry): boolean => {
    if (scope.kind === "all") return true;
    if (scope.kind === "top-level") return parentToolUseId(e) === null;
    return parentToolUseId(e) === ownerId || isEnvelopeOf(e, scope.subagentId);
  };

  /** Spawns folded into THIS view. The owner's own spawn call is deliberately
   *  excluded: folding it would swallow the very slice the view is showing. */
  const foldedIds = new Set<string>();

  const messages: ThreadMessageLike[] = [];
  let openParts: Part[] | null = null;
  let openId = "";
  let openAt: Date | undefined;
  let visible = 0;
  let silent = 0;

  const closeOpen = () => {
    if (openParts && openParts.length > 0) {
      messages.push({
        role: "assistant",
        content: openParts as ThreadMessageLike["content"],
        id: openId,
        createdAt: openAt,
      } as ThreadMessageLike);
    }
    openParts = null;
  };

  thread.forEach((e, i) => {
    if (!inScope(e)) return;
    visible++;
    const content = String(e.content ?? "");

    /* ── Round 808: agent-to-agent traffic is its own kind of message ──────
     * A `comms` entry is a message RELAYED between runs — a worker reporting
     * up, or this run's echo of what it sent down. `commsEntries` writes the
     * inbound one as `role: "user"` so both prompt builders deliver it
     * unchanged, which is correct for the ENGINE and wrong for the READER:
     * it made a builder's report render as an ordinary Konrad bubble.
     *
     * The meta travels to the renderer here, and nothing else about the walk
     * changes. `metadata` is attached ONLY to comms entries, so a thread with
     * none produces byte-identical output to round 602's — which is what
     * check-thread-mapping.ts's "the default did not move" table asserts. */
    const comms = e.kind === "comms" ? readComms(e.meta) : null;

    if (e.role === "user") {
      closeOpen();
      messages.push({
        role: "user",
        content: [{ type: "text", text: content }],
        id: `t${i}`,
        createdAt: entryDate(e),
        ...(comms ? { metadata: { custom: { comms } } } : {}),
      });
      return;
    }
    if (e.role === "system") {
      closeOpen();
      messages.push({
        role: "system",
        content: [{ type: "text", text: content }],
        id: `t${i}`,
        createdAt: entryDate(e),
        metadata: { custom: { kind: e.kind ?? "text", meta: e.meta ?? {} } },
      });
      return;
    }
    /* The OUTBOUND echo (`role: "agent"`, direction "out"): what this run sent
     * to another one. It gets its own message rather than being merged into
     * whatever assistant turn happens to be open around it — merging would
     * bury "you sent this to the builder" inside the operator's own prose,
     * and the direction marker is the whole point of rendering it at all. */
    if (comms && (e.role === "agent" || e.role === "assistant")) {
      closeOpen();
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: content }],
        id: `t${i}`,
        createdAt: entryDate(e),
        metadata: { custom: { comms } },
      } as ThreadMessageLike);
      return;
    }

    // assistant / tool / agent → accumulate into the open assistant message
    if (!openParts) {
      openParts = [];
      openId = `t${i}`;
      openAt = entryDate(e);
    }
    if (e.role === "assistant" || e.role === "agent") {
      if (content.trim()) openParts.push({ type: "text", text: content });
      else silent++;
      return;
    }
    // e.role === "tool"
    if (e.kind === "tool_call") {
      const meta = e.meta ?? {};
      const id = typeof meta.tool_use_id === "string" ? meta.tool_use_id : `c${i}`;
      const part: ToolCallPart = {
        type: "tool-call",
        toolCallId: id,
        toolName:
          typeof meta.tool === "string" && meta.tool
            ? meta.tool
            : content.split(" ")[0] || "tool",
        argsText: typeof meta.input === "string" ? meta.input : content,
      };
      /* An Agent/Task call made AT THIS LEVEL owns a slice of this thread.
       * Fold it: the sub-agent's internals hang off this part instead of being
       * interleaved with the parent's prose, and `subagentId` is what the
       * drill-in descends on. `index` holds the slice it actually produced —
       * absent means spawned-but-nothing-stamped, which is `eventCount: 0`,
       * not a missing fold. */
      if (
        spawnIds !== null &&
        index !== null &&
        id !== ownerId &&
        spawnIds.has(id)
      ) {
        foldedIds.add(id);
        const stat = index.get(id);
        part.subagent = {
          subagentId: id,
          eventCount: stat?.count ?? 0,
          firstTs: stat?.firstTs ?? null,
          lastTs: stat?.lastTs ?? null,
        };
      }
      openParts.push(part);
      return;
    }
    if (e.kind === "tool_result") {
      const meta = e.meta ?? {};
      const id = typeof meta.tool_use_id === "string" ? meta.tool_use_id : null;
      // attach to the matching unresolved tool-call part (search backwards)
      for (let p = openParts.length - 1; p >= 0; p--) {
        const part = openParts[p];
        if (
          part.type === "tool-call" &&
          part.result === undefined &&
          (id === null || part.toolCallId === id)
        ) {
          part.result = content;
          part.isError = meta.is_error === true;
          return;
        }
      }
      // orphaned result — degrade to a text part rather than dropping it
      if (content.trim()) openParts.push({ type: "text", text: content });
      else silent++;
      return;
    }
    /* ── Round 1353: R20 holds for the tool role too ──────────────────────
     * What used to be here was an unconditional `silent++` with the comment
     * "the walk has never rendered these and this round does not change
     * that". That was correct about the kinds it named and wrong as a
     * catch-all: it also swallowed any kind the client has not heard of yet.
     * `notification-gap.md` §3 prescribes exactly such a kind
     * (`task_notification`) built beside `toolResultEntry`, which returns
     * `role: "tool"` — so the payload the whole deliverable exists to surface
     * would have landed in `runs.thread` and died here, silently.
     *
     * The distinction now drawn is deliberate-vs-unknown, not known-vs-all:
     *   - a kind in SILENT_TOOL_KINDS is skipped ON PURPOSE (a heartbeat is
     *     liveness, not transcript). Unchanged behaviour, and it is now a
     *     list a reader can audit rather than a comment.
     *   - anything else degrades to a visible text part, exactly as an
     *     orphaned tool_result does twenty lines above. Empty content still
     *     counts as silent: there is nothing to show.
     * Every kind on the wire today is in one of those two sets, so output on
     * all existing threads is byte-identical — asserted in
     * check-thread-mapping.ts ("the default did not move"). */
    if (SILENT_TOOL_KINDS.has(e.kind ?? "")) {
      silent++;
      return;
    }
    if (content.trim()) openParts.push({ type: "text", text: content });
    else silent++;
  });

  closeOpen();

  /* ── Accounting ───────────────────────────────────────────────────────────
   * A second pass over the SAME thread, classifying every entry the scope did
   * not select. Written as its own walk rather than derived from `total −
   * visible` on purpose: a residual would make `ok` vacuously true and prove
   * nothing. Each entry lands in exactly one bucket because `parent` is
   * single-valued and `foldedIds` never contains `ownerId`. */
  let folded = 0;
  let above = 0;
  let deeper = 0;
  const deeperParents: string[] = [];
  const deeperSeen = new Set<string>();
  for (const e of thread) {
    if (inScope(e)) continue;
    const parent = parentToolUseId(e);
    if (parent === null) {
      above++;
    } else if (foldedIds.has(parent)) {
      folded++;
    } else {
      deeper++;
      if (!deeperSeen.has(parent)) {
        deeperSeen.add(parent);
        deeperParents.push(parent);
      }
    }
  }

  return {
    messages,
    coverage: {
      total: thread.length,
      visible,
      silent,
      folded,
      above,
      deeper,
      deeperParents,
      ok: visible + folded + above + deeper === thread.length,
    },
  };
}

export function mapThreadToMessages(
  thread: ThreadEntry[],
  opts?: MapThreadOptions,
): ThreadMessageLike[] {
  return mapThreadView(thread, opts).messages;
}
