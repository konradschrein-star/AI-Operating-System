"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * Query defaults.
 *
 * These used to carry a GLOBAL `refetchInterval: 5_000`, which meant every
 * query in the app — chat list, file tree, memory, skills, projects, spend —
 * refetched every five seconds forever, whether or not anything could have
 * changed and whether or not the surface was even visible. Each refetch
 * re-rendered its whole component tree, so the UI was permanently busy: that
 * is what "laggy for no reason when I click a button" actually was.
 *
 * Polling is now OPT-IN. The handful of genuinely live surfaces already
 * declare their own interval (agent activity 4s, project board 6s, chat
 * detail 3s while running); everything else fetches on mount and on demand.
 *
 * `refetchOnWindowFocus` is off for the same reason — alt-tabbing back should
 * not restart every request in the app. Anything truly live is polling anyway.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data stays usable for a minute before a refetch is considered;
            // navigating back to a surface reuses the cache instead of
            // blanking and refetching (which is what made tab switches stutter).
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            refetchOnMount: true,
            retry: 2,
            // Exponential backoff, capped. Matters for the quota endpoint,
            // which returns 429 when polled too eagerly — retrying instantly
            // just deepens the rate limit.
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
          },
        },
      }),
  );
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
