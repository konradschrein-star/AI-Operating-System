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
 *  Source of truth for every type below: forge-control/src/routes/chat.ts —
 *  `interface PlanTask`, `interface PlanPhase`, `interface PlanResponse`.
 *  These are hand-mirrored, not imported: there is no shared build across the
 *  two repos, and drifting them is the failure mode the mirroring accepts in
 *  exchange. So every mirror moves in the SAME commit as the server type.
 *
 *  CITED BY SYMBOL, deliberately (00-vision.md §7 rule 1). This header and the
 *  three interface comments below used to pin `chat.ts:650-689`,
 *  `chat.ts:650-660`, `chat.ts:662-674` and `chat.ts:676-689`. At git SHA
 *  `7efa36b` those three interfaces already sat at 657-667, 669-682 and
 *  684-706 — the pins had rotted and read as authoritative while being wrong,
 *  and round 222's server commit moved them again. A symbol name cannot rot,
 *  so the line numbers are not re-pinned to fresh ones; they are gone.
 *
 *  Both endpoints shipped in phase 300i; nothing here is speculative.
 */

const ROOT = "/api/proxy";

/** One project task. `tier` is `string | null` and null is a REAL value: the
 *  engine picks a default for tier-less tasks, so null means "the engine will
 *  choose", not "unknown". chat.ts:`interface PlanTask`. */
export interface PlanTask {
  id: string;
  round: number;
  role: string;
  title: string;
  /** Free-form on purpose — see the note above `KNOWN_STATUSES` in
   *  ./planStore. The server does not narrow it and neither do we. */
  status: string;
  tier: string | null;
  /** Task ids this one waits on — REAL EDGES since R54, and which kind depends
   *  on the row: the engine's recorded `depends_on` when it recorded one
   *  (including `[]`, an explicit graph root that yields no edges at all), and
   *  the synthesised "every task in a strictly lower round" set for a LEGACY
   *  row, whose `depends_on` is the NULL sentinel. The server chooses between
   *  the two with a single `=== null` test and never merges them
   *  (chat.ts:`groupPlanPhases`).
   *
   *  Both kinds can appear in ONE response — a project that straddles the
   *  migration reads as one board, not two — so nothing here may assume the
   *  edges of two tasks were produced by the same rule.
   *
   *  A dep id naming no task in this response is emitted VERBATIM by the
   *  server: R27 makes a dangling dep unreachable through the API, so one
   *  arriving means a corrupt row, and the panel is the surface that must show
   *  it rather than tidy it away. */
  deps: string[];
  /** Which workstream worktree the task runs in (R55). `'main'` for every row
   *  that predates migration 0040 and every row that does not ask for another:
   *  the column is NOT NULL DEFAULT 'main', so this is never null and never
   *  absent. `workstreamLabel` in ./planStore is the rule for showing it, and
   *  it shows nothing for `'main'`. */
  workstream: string;
  /** DERIVED longest-path depth from the graph roots (R55) — computed by the
   *  server's `taskDepth()`, never stored. NOT `round`: `round` is the
   *  planner's narrative phase number and `depth` is how far down the
   *  dependency chain the task actually sits. They agree only by coincidence,
   *  and the Kanban still groups by `round` (see `phaseBase` in ./planStore).
   *
   *  When the stored graph cannot be ordered at all, the server sets every
   *  task's depth to its own `round` and says so in `PlanResponse.graph_error`
   *  — so a `depth` that equals `round` everywhere is a fact to read together
   *  with that field, not on its own. */
  depth: number;
}

/** One hundreds-block of the plan. chat.ts:`interface PlanPhase`. */
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

/** chat.ts:`interface PlanResponse`. */
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
   *  unaffected and still present when this is set.
   *
   *  ROUND 1871: this is PROSE and the panel prints it verbatim. It used to be
   *  a stringified Node error — `plan docs unreadable at /opt/…: ENOENT: no
   *  such file or directory, scandir '…'` — rendered into Konrad's panel. */
  error?: string;
  /** Set when the server's `taskDepth()` refused to order the stored graph — a
   *  cycle in `depends_on`. Carries the thrown message VERBATIM, ids and all,
   *  and every task's `depth` is then its own `round` (chat.ts:`planDepths`).
   *
   *  A SEPARATE field from `error` on purpose, and the mirror keeps them
   *  apart: `error` means "the docs listing failed" and nothing else.
   *  Overloading one field would make two unrelated degradations
   *  indistinguishable to the reader who has to act on them. The phases are
   *  real and still drawn in both cases. */
  graph_error?: string;
  /** The raw fs error behind `error`. Rendered as a disclosure, never as the
   *  headline. Absent on a pre-1871 server. */
  error_detail?: string;
}

/* ── Fetchers ─────────────────────────────────────────────────────────────
 *
 * Same idiom as `fetchChatTeam` in ./teamApi: bare fetch, explicit accept
 * header, THROW on non-2xx with the status in the message. There is no `catch`
 * that turns a 500 into an empty plan — an empty plan and a broken server must
 * never look the same in the panel (NFU6). react-query surfaces the thrown
 * error; the panel renders it inline.
 */

/** `projectId` mirrors `fetchChatTeam`'s (round 1871): the board and the team
 *  tree sit in one panel and must never be looking at different projects. */
export const fetchChatPlan = async (
  chatId: string,
  projectId?: string | null,
): Promise<PlanResponse> => {
  const q = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  const r = await fetch(`${ROOT}/chat/${encodeURIComponent(chatId)}/plan${q}`, {
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
export const fetchPlanDoc = async (
  chatId: string,
  name: string,
  projectId?: string | null,
): Promise<string> => {
  const project = projectId ? `&project_id=${encodeURIComponent(projectId)}` : "";
  const r = await fetch(
    `${ROOT}/chat/${encodeURIComponent(chatId)}/plan/doc?name=${encodeURIComponent(name)}${project}`,
    { headers: { accept: "text/markdown, application/json" } },
  );
  if (!r.ok) throw new Error(await planDocError(r));
  return await r.text();
};
