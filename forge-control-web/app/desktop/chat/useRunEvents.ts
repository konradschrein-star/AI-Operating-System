"use client";

/**
 * SSE subscription for a single run. Replaces the 3s polling loop that
 * made chat feel dead — snapshots land within ~1s of the executor
 * appending a streamed CC event to runs.thread.
 *
 * Wire: EventSource → /api/events/:id (Next route handler) →
 * forge-control /api/chat/:id/events. Snapshots are written straight
 * into the TanStack Query cache so every consumer re-renders.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RunDetail } from "../../api";

export function useRunEvents(runId: string | null, enabled: boolean): {
  live: boolean;
} {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const lastStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runId || !enabled) {
      setLive(false);
      return;
    }
    let closed = false;
    const es = new EventSource(`/api/events/${runId}`);

    es.addEventListener("open", () => {
      if (!closed) setLive(true);
    });
    es.addEventListener("snapshot", (ev) => {
      try {
        const { run } = JSON.parse((ev as MessageEvent).data) as {
          run: RunDetail;
        };
        qc.setQueryData(["chat", "run", run.id], run);
        if (lastStatusRef.current !== run.status) {
          lastStatusRef.current = run.status;
          void qc.invalidateQueries({ queryKey: ["chat", "list"] });
        }
      } catch {
        // malformed frame — the polling fallback still covers us
      }
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
  }, [runId, enabled, qc]);

  return { live };
}
