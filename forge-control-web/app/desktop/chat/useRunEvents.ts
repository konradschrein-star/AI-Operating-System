"use client";

/**
 * SSE subscription for a single run. Replaces the 3s polling loop that
 * made chat feel dead — updates land within ~1s of the executor
 * appending a streamed CC event to runs.thread.
 *
 * Wire: EventSource → /api/events/:id (Next route handler) →
 * forge-control /api/chat/:id/events.
 *
 * Protocol (see forge-control/src/routes/chat.ts):
 *   snapshot  {run}                    — full run, sent once on connect
 *   append    {from, entries, run}     — `run` has no `thread`; splice
 *                                        `entries` in at index `from`
 *   gone      {}                       — run deleted
 *
 * The server used to re-send the whole thread on every tool event, which
 * cost O(n²) bytes per run and re-mapped the entire message list in
 * AssistantThread each time. Appends keep the cached `thread` array's
 * prefix identity stable, so only the new rows render.
 *
 * Resync: if an append arrives that we cannot splice (its `from` is past
 * the end of what we hold — a frame was dropped, or the cache entry was
 * evicted), we tear the connection down and reopen. A fresh connection
 * always begins with a snapshot, so that is the recovery path. Throttled
 * so a persistent mismatch can never become a reconnect loop.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RunDetail, ThreadEntry } from "../../api";

/** `run` on an append frame is a RunDetail with `thread` stripped off. */
type RunMeta = Omit<RunDetail, "thread">;

interface AppendFrame {
  from: number;
  entries: ThreadEntry[];
  run: RunMeta;
}

const RESYNC_MIN_INTERVAL_MS = 3_000;

export function useRunEvents(runId: string | null, enabled: boolean): {
  live: boolean;
} {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const lastStatusRef = useRef<string | null>(null);
  const lastResyncRef = useRef(0);
  const [resyncNonce, setResyncNonce] = useState(0);

  /** Force a fresh stream (→ fresh snapshot). If we already reconnected
   *  moments ago, refetch the run over HTTP instead: same repair, no risk
   *  of hammering the endpoint. */
  const resync = useCallback(
    (id: string) => {
      const now = Date.now();
      if (now - lastResyncRef.current < RESYNC_MIN_INTERVAL_MS) {
        void qc.invalidateQueries({ queryKey: ["chat", "run", id] });
        return;
      }
      lastResyncRef.current = now;
      setResyncNonce((n) => n + 1);
    },
    [qc],
  );

  useEffect(() => {
    if (!runId || !enabled) {
      setLive(false);
      return;
    }
    let closed = false;
    const es = new EventSource(`/api/events/${runId}`);

    const noteStatus = (status: string) => {
      if (lastStatusRef.current !== status) {
        lastStatusRef.current = status;
        void qc.invalidateQueries({ queryKey: ["chat", "list"] });
      }
    };

    es.addEventListener("open", () => {
      if (!closed) setLive(true);
    });

    es.addEventListener("snapshot", (ev) => {
      try {
        const { run } = JSON.parse((ev as MessageEvent).data) as {
          run: RunDetail;
        };
        qc.setQueryData(["chat", "run", run.id], run);
        noteStatus(run.status);
      } catch {
        // malformed frame — the polling fallback still covers us
      }
    });

    es.addEventListener("append", (ev) => {
      let frame: AppendFrame;
      try {
        frame = JSON.parse((ev as MessageEvent).data) as AppendFrame;
      } catch {
        return; // malformed frame — polling fallback covers us
      }
      const { from, entries, run: meta } = frame;
      if (!meta || typeof from !== "number" || !Array.isArray(entries)) return;
      const key = ["chat", "run", meta.id];
      const prev = qc.getQueryData<RunDetail>(key);
      const tail = (prev?.from ?? 0) + (prev?.thread?.length ?? 0);
      if (!prev || from > tail || from < (prev.from ?? 0)) {
        // Nothing to splice onto, or a hole between what we hold and what
        // the server is sending. Only a full snapshot can fix this.
        resync(meta.id);
        return;
      }
      const localFrom = from - (prev.from ?? 0);
      const thread =
        entries.length === 0 && from === tail
          ? prev.thread // status/updated_at-only frame — keep array identity
          : [...prev.thread.slice(0, localFrom), ...entries];
      const total = Math.max(
        prev.total ?? tail,
        (prev.from ?? 0) + thread.length,
      );
      qc.setQueryData<RunDetail>(key, {
        ...prev,
        ...meta,
        thread,
        from: prev.from ?? 0,
        total,
      });
      noteStatus(meta.status);
    });

    es.addEventListener("gone", () => {
      es.close();
      setLive(false);
    });

    es.onerror = () => {
      // EventSource auto-reconnects; flag as not-live so the query
      // fallback interval tightens until the stream is back.
      if (!closed) setLive(false);
    };

    return () => {
      closed = true;
      es.close();
      setLive(false);
    };
  }, [runId, enabled, qc, resync, resyncNonce]);

  return { live };
}
