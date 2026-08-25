/**
 * resolve-path.ts — turn a reference an agent wrote into a concrete
 * (root, path) the file API will actually serve.
 *
 * WHY IT IS ITS OWN FILE. Two surfaces need the identical answer: the chat
 * pill in `MessageMarkdown` (open in the Files panel) and the full-window
 * `/document` viewer, which is where a Ctrl/Cmd-click and the no-panel
 * fallback both land — `/document?wikilink=Operating%20Manual` has to place
 * the note exactly the way the pill did, or the same click gives two answers.
 * `code-path-link.ts` stays pure (no fetch, no React); this file is the half
 * that talks to the API.
 *
 * NO SILENT FAILURE ANYWHERE. Every function here returns a discriminated
 * `Resolution`, never `null`: the caller is expected to say something. The
 * first live test of this feature failed exactly by being silent — the click
 * fired, two searches went out, neither matched, and nothing happened on
 * screen, which is indistinguishable from a dead handler. A search that
 * answers 500 is a different fact from a search that answers "no hits", and
 * both reach the reader as words (`detail`), not as a shrug.
 *
 * NO NEW POLL. `knownRoots()` is the one cached module promise; the roots are
 * fetched once per page load and every resolution reuses it.
 */

import { fetchFileRoots, searchFiles, type FileRoot, type FileSearchEntry } from "../../api";
import type { PathTarget, RootKey } from "./code-path-link";

/**
 * Roots searched for a name that carries no root of its own, in the order
 * Konrad is likeliest to mean.
 *
 * ORDER, and why it changed (PLAN.md finding 5). The vault stays first: most
 * references in chat are to his own notes. But `workspace` used to come
 * second, and `workspace` contains 46 worktree copies of `MessageMarkdown.tsx`
 * — clicking a source file that agents discuss all day walked a huge tree and
 * then opened somebody's abandoned worktree copy. The source trees the fleet
 * actually reads (`forge-src`, then `aios`) now come before it, and `workspace`
 * is last of all, which is also the correct order by "how likely is this hit
 * the file the author meant".
 */
const SEARCH_ROOTS: readonly RootKey[] = [
  "vault",
  "forge-src",
  "aios",
  "uploads",
  "memory",
  "workspace",
];

/**
 * How long ONE root gets to answer a filename search before the resolution
 * stops waiting for it.
 *
 * 6s, chosen against two measurements and not by feel: the two big trees
 * (`aios` 13.9s, `workspace` 11.7s) are what a miss actually costs, and the UX
 * bar the regression check enforces is 8s
 * (`check-chat-reference-navigation.mjs`, `MISS_BUDGET_MS`). 6s leaves the
 * round trip, the React render and the toast inside the budget while still
 * being long enough that a merely-busy root is not abandoned — the four fast
 * roots answer in 0.04-0.23s, two orders of magnitude under it.
 *
 * A HIT IS NOT AFFECTED BY THIS. The loop below returns as soon as the
 * highest-priority root that hit has answered, so the deadline only ever
 * shortens the case where the answer is "nothing matched anywhere".
 */
const ROOT_DEADLINE_MS = 6000;

/**
 * The roots the API actually serves right now, fetched once and cached.
 *
 * The prefix table in code-path-link.ts is a static map and the server's ROOTS
 * is the truth. They go out of step for real: `aios` and `forge-src` were added
 * to both on 2026-08-25, `memory` right after, but forge-control only picks up
 * a route change on restart — and a restart waits for the fleet to go quiet. In
 * that window the UI would confidently open /document on a root the API has
 * never heard of and render "(failed to load)". Asking is cheaper than guessing.
 *
 * An empty set means the lookup itself failed; every caller below treats that
 * as "unknown, proceed" rather than "no roots exist", so a flaky /files/roots
 * degrades to today's behaviour instead of disabling the feature.
 */
let rootsPromise: Promise<FileRoot[]> | null = null;

/**
 * The roots as the API describes them — KEY AND LABEL — fetched once per page
 * load and shared by everything that needs either.
 *
 * `fetchFileRoots` in `api.ts` is a plain fetch with no cache of its own, and
 * this is the module promise the brief's no-new-poll rule refers to. It caches
 * the PROMISE, not the value, so N callers racing on first paint make one
 * request; a rejection is deliberately NOT cached, so a flaky roots response
 * does not poison the page for its whole lifetime.
 *
 * It holds `FileRoot[]` rather than the key set it used to, because the
 * BREADCRUMB needs the labels and had no cached way to get them: the panel
 * mounts only when the tab flips to Files — i.e. after the click — and paid a
 * fresh round trip for labels it was about to render, so a resolution that
 * landed fast enough (0.9s, measured) drew "Home/vault/…" before the labels
 * arrived. Reading them off this already-settled promise makes it a microtask.
 */
export function cachedFileRoots(): Promise<FileRoot[]> {
  if (!rootsPromise) {
    rootsPromise = fetchFileRoots().catch((e: unknown) => {
      rootsPromise = null;
      throw e;
    });
  }
  return rootsPromise;
}

/** Just the keys, for "does this server serve that root". An empty set means
 *  the lookup itself failed — see the callers, which all treat that as
 *  "unknown, proceed" rather than "no roots exist". */
export function knownRoots(): Promise<Set<string>> {
  return cachedFileRoots()
    .then((rs) => new Set(rs.map((r) => r.key)))
    .catch(() => new Set<string>());
}

/** Test seam: drop the cached roots promise so a check can re-fetch. Never
 *  called by the app — the cache is the whole point there. */
export function resetKnownRootsForTests(): void {
  rootsPromise = null;
}

/** Where a reference resolved to, or why it did not. */
export type Resolution =
  | {
      ok: true;
      root: string;
      path: string;
      /** 1-based line carried through from `path:LINE` (D1). */
      line?: number;
      /** The reference named a directory (D5): list it, do not preview it. */
      isDir?: boolean;
    }
  | {
      ok: false;
      /** `root-not-live`: the mapping is right, this server has not restarted.
       *  `not-found`: the searches ran and matched nothing.
       *  `search-failed`: at least one search errored, so "not found" would be
       *  a lie — we genuinely do not know. */
      reason: "root-not-live" | "not-found" | "search-failed";
      /** The name to put in front of the reader. */
      label: string;
      /** One sentence of diagnostics, shown in the toast. Never empty. */
      detail: string;
    };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Rank the hits of a filename search and take the best one.
 *
 * Tiers, in order: the author's whole path exactly; the author's path as a
 * suffix ("Profile/OPEN-QUESTIONS.md" should beat a same-named file elsewhere);
 * the exact filename (searching "Operator Log.md" also returns "AI OS Operator
 * Log.md"); anything at all.
 *
 * Within a tier, `workspace` deprioritises `projects/` — that subtree is the
 * fleet's worktrees, dozens of copies of the same file, and a copy inside a
 * half-finished worktree is never what an agent meant by a bare filename.
 */
function pickHit(
  root: RootKey,
  entries: FileSearchEntry[],
  want: { query: string; label: string; isDir: boolean },
): FileSearchEntry | null {
  const candidates = entries.filter((e) => e.isDir === want.isDir);
  const wantPath = want.query.toLowerCase();
  const wantName = want.label.toLowerCase();
  const tiers: Array<(e: FileSearchEntry) => boolean> = [
    (e) => e.path.toLowerCase() === wantPath,
    (e) => e.path.toLowerCase().endsWith(`/${wantPath}`),
    (e) => e.name.toLowerCase() === wantName,
    () => true,
  ];
  for (const tier of tiers) {
    const hits = candidates.filter(tier);
    if (hits.length === 0) continue;
    if (root !== "workspace") return hits[0];
    return hits.find((e) => !e.path.startsWith("projects/")) ?? hits[0];
  }
  return null;
}

/**
 * A reference that already names its root: check it against what this server
 * actually serves, and hand it back.
 *
 * Shared by `detectPath`'s `exact` targets and by `/document?root=&path=`,
 * which is where a Ctrl-click and the no-panel fallback land. The `memory`
 * root is exactly why this check exists: it is in the client's prefix table
 * and in the router's source, and it stays absent from the running server
 * until forge-control restarts — so the honest answer for a click on
 * `/root/.claude/projects/-opt-forge-ai-os/memory/` today is "not live yet",
 * not a viewer that says "(failed to load)".
 *
 * THE TOAST IS THE GUARD WORKING, NOT A GAP TO CLOSE (manager ruling,
 * 2026-08-25). Do not delete this check to stop the "isn't live" message
 * appearing — the message goes away by itself the moment forge-control
 * restarts into a router that serves the root. Removing the check would trade
 * an accurate sentence for a broken viewer.
 */
export async function resolveRootPath(
  root: string,
  path: string,
  opts: { label?: string; line?: number; isDir?: boolean } = {},
): Promise<Resolution> {
  const label = opts.label ?? (path.split("/").pop() || root);
  const live = await knownRoots();
  if (live.size > 0 && !live.has(root)) {
    return {
      ok: false,
      reason: "root-not-live",
      label,
      detail: `The "${root}" file root isn't live on this server yet.`,
    };
  }
  return {
    ok: true,
    root,
    path,
    ...(opts.line !== undefined ? { line: opts.line } : null),
    ...(opts.isDir ? { isDir: true } : null),
  };
}

/**
 * Place a `PathTarget` from `detectPath()`.
 *
 * An `exact` target already knows its root and only has to be checked against
 * what the server serves. A `search` target is placed by asking /files/search
 * — BY FILENAME, NOT BY THE PATH: the route matches with
 * `name.toLowerCase().includes(q)` against each entry's NAME, so a query
 * containing a slash can never match anything (measured: clicking
 * `Mentor/Profile/Operating Manual.md` sent the whole path, got zero hits, and
 * the click did nothing). The directory part is not thrown away — it is what
 * ranks the results in `pickHit`.
 */
export async function resolveTarget(target: PathTarget): Promise<Resolution> {
  const line = target.line;
  const isDir = target.isDir === true;

  if (target.kind === "exact") {
    return resolveRootPath(target.root, target.path, {
      label: target.label,
      line,
      isDir,
    });
  }

  const live = await knownRoots();
  // A root the server does not serve yet answers 400/404 for everything;
  // skipping it keeps the diagnostics about the search that matters.
  const searched = SEARCH_ROOTS.filter((root) => live.size === 0 || live.has(root));

  /* FIRED TOGETHER, READ IN ORDER, AND EACH ONE ON A CLOCK. Three properties,
   * and each of them is a separately measured defect.
   *
   * 1. CONCURRENT. These searches used to run in a `for` loop with an `await`
   *    per root, so a reference that matched nothing paid for all of them one
   *    after another: 39.0s measured 2026-08-25, 14.8-159.3s across the runs the
   *    README records. Measured per root against the live route, same query:
   *    vault 0.04s, forge-src 0.14s, uploads 0.23s, workspace 11.69s, aios
   *    13.91s. The sum is the whole problem and the max is the honest cost.
   *
   * 2. READ IN `SEARCH_ROOTS` ORDER, awaiting one promise at a time. The array
   *    is built by `.map`, so every request is already in flight before the
   *    first `await` — but the ANSWER is still the first root in priority order
   *    that hit, exactly as the serial loop decided it. This is not a detail:
   *    a plain `Promise.all` collects every root before deciding, which made a
   *    vault hit that used to land in 0.3-0.6s wait 11.0s for `aios` to finish
   *    saying no (measured, this round, before this loop existed). A hit now
   *    costs what ITS root costs; only a miss pays for the slowest root.
   *
   * 3. DEADLINED PER ROOT. A miss must still wait for everything, and the two
   *    big trees put that at ~14s against an 8s UX bar. A root that has not
   *    answered within `ROOT_DEADLINE_MS` is abandoned — reported by name in the
   *    diagnostic, never silently dropped, so "Couldn't find X" always arrives
   *    with the sentence that says which roots were not searched to the end. The
   *    in-flight request is left to finish and be discarded: `searchFiles` takes
   *    no AbortSignal, and inventing one here would be a route change smuggled
   *    into a latency fix. */
  type Outcome = {
    root: RootKey;
    hit: FileSearchEntry | null;
    error: string | null;
    timedOut: boolean;
  };
  const pending: Promise<Outcome>[] = searched.map((root) => {
    const search: Promise<Outcome> = searchFiles(root, "", target.label).then(
      ({ entries }) => ({
        root,
        hit: pickHit(root, entries, { query: target.query, label: target.label, isDir }),
        error: null,
        timedOut: false,
      }),
      (e: unknown) => ({ root, hit: null, error: errorText(e), timedOut: false }),
    );
    const deadline = new Promise<Outcome>((resolve) => {
      setTimeout(() => resolve({ root, hit: null, error: null, timedOut: true }), ROOT_DEADLINE_MS);
    });
    return Promise.race([search, deadline]);
  });

  const outcomes: Outcome[] = [];
  for (const p of pending) {
    const o = await p;
    outcomes.push(o);
    if (o.hit) {
      return {
        ok: true,
        root: o.root,
        path: o.hit.path,
        ...(line !== undefined ? { line } : null),
        ...(isDir ? { isDir: true } : null),
      };
    }
  }

  const failures = outcomes
    .filter((o): o is Outcome & { error: string } => o.error !== null)
    .map((o) => `${o.root}: ${o.error}`);
  if (failures.length > 0) {
    return {
      ok: false,
      reason: "search-failed",
      label: target.label,
      detail: `Search failed — ${failures.join("; ")}.`,
    };
  }
  const abandoned = outcomes.filter((o) => o.timedOut).map((o) => o.root);
  return {
    ok: false,
    reason: "not-found",
    label: target.label,
    detail: `No ${isDir ? "folder" : "file"} matching "${target.query}" in ${
      searched.join(", ") || "any live root"
    }.${
      abandoned.length > 0
        ? ` (${abandoned.join(", ")} did not answer within ${ROOT_DEADLINE_MS / 1000}s and was not searched to the end.)`
        : ""
    }`,
  };
}

/** A name that already ends in an extension we should not re-suffix.
 *  `[[2026-08-25]]` is a daily note, not a file with a ".25" extension, so the
 *  tail has to look like an extension: letters and digits, no spaces. */
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * Place a `[[wikilink]]` (D2). Konrad's vault runs on them and agents write
 * them, so they resolve into the VAULT and nowhere else: a wikilink is an
 * Obsidian construct, and searching the source trees for one would open a
 * random same-named file from a worktree.
 *
 * `name` is the basename (what a filename search can match) and `path` is
 * non-null only when the author wrote it path-qualified (`[[Dir/Note]]`),
 * which is what ranks a hit when the vault has two notes of the same name.
 */
export async function resolveWikilink(
  name: string,
  path?: string | null,
): Promise<Resolution> {
  const trimmed = name.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: "not-found",
      label: name,
      detail: "The wikilink named no note.",
    };
  }
  // Obsidian writes `[[Operating Manual]]` for `Operating Manual.md`, but a
  // link to an attachment (`[[diagram.png]]`) carries its own extension.
  const fileName = HAS_EXTENSION.test(trimmed) ? trimmed : `${trimmed}.md`;
  const query = path ? (HAS_EXTENSION.test(path) ? path : `${path}.md`) : fileName;

  try {
    const { entries } = await searchFiles("vault", "", fileName);
    const hit = pickHit("vault", entries, {
      query,
      label: fileName,
      isDir: false,
    });
    if (hit) return { ok: true, root: "vault", path: hit.path };
  } catch (e) {
    return {
      ok: false,
      reason: "search-failed",
      label: trimmed,
      detail: `Search failed — vault: ${errorText(e)}.`,
    };
  }
  return {
    ok: false,
    reason: "not-found",
    label: trimmed,
    detail: `No note named "${fileName}" in the vault.`,
  };
}
