/**
 * A one-message bus: "open this file in the Files panel."
 *
 * WHY A BUS AND NOT A PROP. The publisher is `MessageMarkdown`, which sits at
 * the bottom of the message list; the two subscribers are `ChatSurface` (to
 * switch the right sidebar to the Files tab) and `FileExplorerPanel` (to
 * navigate and select). Threading a callback down would mean a new prop on
 * every component between them — and `MessageMarkdown` is `memo`ised on
 * `source` alone, deliberately, because re-parsing markdown on every streamed
 * token was the single largest source of chat lag. A new prop would either
 * break that memo or have to be routed around it. A module-level subscription
 * touches neither.
 *
 * Deliberately not a general event system: one payload shape, no wildcard
 * topics, no history. If a second kind of message ever wants a bus, it gets
 * its own file rather than a `type` field here.
 */

export interface OpenFileRequest {
  root: string;
  /** Path relative to the root, e.g. "Mentor/Profile/OPEN-QUESTIONS.md". */
  path: string;
}

type Listener = (req: OpenFileRequest) => void;

const listeners = new Set<Listener>();

/**
 * THE LATCH, and why a plain event bus was broken here.
 *
 * `FileExplorerPanel` is mounted ONLY while the right sidebar is on its Files
 * tab — ChatSurface renders `tab === "team" ? <ChatTeamPanel/> : <FileExplorer
 * Panel/>`. The Team tab is the default. So the sequence for the common case
 * is: click a path → dispatch → ChatSurface switches the tab → the panel
 * mounts and subscribes. The panel's subscription does not exist until AFTER
 * the event has been delivered to everyone who was listening, so it never sees
 * it. The tab flipped and the file did not open, which is exactly what Konrad
 * saw.
 *
 * The request is therefore held here until somebody takes it. A late-mounting
 * subscriber calls `consumePendingOpenFile()` and gets the request it missed.
 * Whoever acts on a request clears it, so it fires once and cannot re-open the
 * same file on some unrelated remount later.
 */
let pending: OpenFileRequest | null = null;

export function subscribeOpenFile(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Take the request that arrived before this subscriber existed, if any. */
export function consumePendingOpenFile(): OpenFileRequest | null {
  const req = pending;
  pending = null;
  return req;
}

/** Mark the latched request handled without taking it — for a subscriber that
 *  received the live dispatch and is acting on it now. */
export function clearPendingOpenFile(): void {
  pending = null;
}

export function requestOpenFile(req: OpenFileRequest): void {
  pending = req;
  // Copy before iterating: a listener that unsubscribes itself during
  // dispatch would otherwise mutate the set mid-loop.
  for (const fn of [...listeners]) {
    try {
      fn(req);
    } catch {
      // One bad subscriber must not stop the others from opening the file.
    }
  }
}

/** Split "a/b/c.md" into the containing dir and the file name. */
export function splitRel(path: string): { parentRel: string; name: string } {
  const i = path.lastIndexOf("/");
  return i === -1
    ? { parentRel: "", name: path }
    : { parentRel: path.slice(0, i), name: path.slice(i + 1) };
}
