/** Client for GET /api/chat/:id/plan and GET /api/chat/:id/plan/doc — the data
 *  layer of the v3 right panel's Kanban zone and its plan-doc reader
 *  (13-ui-v3-architecture.md §7, U6/U25/U26).
 *
 *  Its own module rather than an addition to ./teamApi for the same reason
 *  teamApi is not part of ./live/agentsApi: the Kanban has its own wire
 *  contract on its own endpoint, and neither surface should drag the other
 *  when the server shape moves. Nothing here imports React, so
 *  `scripts/checks/check-plan-store.ts` can import it directly under tsx.
 *
 *  Source of truth for every type below: forge-control/src/routes/chat.ts
 *  (interfaces PlanTask / PlanPhase / PlanResponse, lines 650-689). These are
 *  hand-mirrored, not imported — this module must not reach across repos. When
 *  the server shape changes, this file changes with it.
 *
 *  Both endpoints shipped in phase 300i; nothing here is speculative.
 */

const ROOT = "/api/proxy";

/** One project task. `tier` is `string | null` and null is a REAL value: the
 *  engine picks a default for tier-less tasks, so null means "the engine will
 *  choose", not "unknown". See chat.ts:650-660. */
export interface PlanTask {
  id: string;
  round: number;
  role: string;
  title: string;
  /** Free-form on purpose — see the note above `KNOWN_STATUSES` in
   *  ./planStore. The server does not narrow it and neither do we. */
  status: string;
  tier: string | null;
  /** Task ids this one waits on. Coarse today (every task in a strictly lower
   *  round); the shape does not change when the engine records true per-task
   *  deps. chat.ts:`groupPlanPhases`. */
  deps: string[];
}

/** One hundreds-block of the plan. chat.ts:662-674. */
export interface PlanPhase {
  /** `floor(round / 100) * 100`, decided by the server. */
  round_base: number;
  /** The block's opening task title, when a task sits exactly on the base
   *  round. ABSENT is the honest answer when it does not — the server refuses
   *  to invent a phase label and so must the client. */
  title?: string;
  tasks: PlanTask[];
  /** Present ONLY when a file in the project's corpus (see `corpus` on the
   *  response) carries this block's number. Absent means no document, not
   *  "look one up yourself". */
  doc_path?: string;
}

/** chat.ts:676-689. */
export interface PlanResponse {
  chat_id: string;
  project: { id: string; status: string | null } | null;
  /** `"thread_scan"` means the chat↔project link was inferred, not recorded;
   *  the panel marks it "linked heuristically" (U2/NFU6). */
  link_source: "metadata" | "thread_scan" | null;
  link_ambiguous: boolean;
  phases: PlanPhase[];
  /** File names (not paths) of the project's own plan corpus, sorted. Bare
   *  names on purpose: `fetchPlanDoc` sends one back verbatim and the server
   *  refuses anything containing a directory, so the client never needs — and
   *  is never told — the path. */
  docs: string[];
  /** Round 906: WHICH directory those names came from. A project created since
   *  C18 (or relocated, as this one was) keeps its corpus in
   *  `docs/plan/<slug>/`; older projects are still flat in `docs/plan/`. Before
   *  the server started choosing, this panel listed the flat directory of a
   *  namespaced project's worktree — which holds ANOTHER project's corpus. */
  corpus?: { dir: string; namespaced: boolean };
  /** Set when the docs listing failed. `docs: []` on its own would read as
   *  "this project has no plan corpus", which is a different fact from "the
   *  corpus could not be read, and here is why" (NFU6). The phases are
   *  unaffected and still present when this is set. */
  error?: string;
}

/* ── Fetchers ─────────────────────────────────────────────────────────────
 *
 * Same idiom as `fetchChatTeam` in ./teamApi: bare fetch, explicit accept
 * header, THROW on non-2xx with the status in the message. There is no `catch`
 * that turns a 500 into an empty plan — an empty plan and a broken server must
 * never look the same in the panel (NFU6). react-query surfaces the thrown
 * error; the panel renders it inline.
 */

export const fetchChatPlan = async (chatId: string): Promise<PlanResponse> => {
  const r = await fetch(`${ROOT}/chat/${encodeURIComponent(chatId)}/plan`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on /chat/:id/plan`);
  return (await r.json()) as PlanResponse;
};

/**
 * The server's own sentence for a failed doc fetch, or the status line.
 *
 * `/plan/doc` is the one endpoint in this panel that answers `text/markdown`
 * on success and JSON on failure (chat.ts:`r.get("/:id/plan/doc")` — 400
 * rejected name, 404 no such document, 413 over the size cap, 500 fs error).
 * Every one of those bodies is `{error, name}` and every `error` names itself:
 * "rejected: only .md documents are served, got: notes.txt" tells the reader
 * what to do next; "400 Bad Request" tells them nothing. So the server's text
 * wins whenever it exists, and the status line is only the fallback for a body
 * that is not the JSON the endpoint promises.
 */
async function planDocError(r: Response): Promise<string> {
  const fallback = `${r.status} ${r.statusText} on /chat/:id/plan/doc`;
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    // Not JSON at all (a proxy's HTML error page, an empty body). The status
    // line is then genuinely everything we know — not a swallowed error.
    return fallback;
  }
  if (typeof body === "object" && body !== null && "error" in body) {
    const message = (body as { error: unknown }).error;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

/** One plan document, as raw markdown for `MessageMarkdown` (U26). */
export const fetchPlanDoc = async (chatId: string, name: string): Promise<string> => {
  const r = await fetch(
    `${ROOT}/chat/${encodeURIComponent(chatId)}/plan/doc?name=${encodeURIComponent(name)}`,
    { headers: { accept: "text/markdown, application/json" } },
  );
  if (!r.ok) throw new Error(await planDocError(r));
  return await r.text();
};
