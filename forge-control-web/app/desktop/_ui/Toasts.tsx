"use client";

/**
 * Minimal toast bus.
 *
 * The console had no way to tell you something failed. Mutations
 * (send message, cancel, resume, close chat …) declared `onSuccess` and
 * nothing else, so a failed send was indistinguishable from a send that
 * worked — the composer cleared either way (audit §1.4).
 *
 * Deliberately a module-level bus rather than a React context: the call
 * sites are TanStack `onError` callbacks scattered across surfaces, and
 * threading a provider through every one of them buys nothing. Import
 * `toast`, call it, done. `<ToastHost/>` renders wherever it is mounted;
 * DesktopApp mounts exactly one.
 */

import { useEffect, useState } from "react";
import { tokens } from "../../tokens";

export type ToastTone = "error" | "info" | "ok";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  detail?: string;
}

type Listener = (t: Toast) => void;

const listeners = new Set<Listener>();
let nextId = 1;

export function toast(
  message: string,
  tone: ToastTone = "info",
  detail?: string,
): void {
  const t: Toast = { id: nextId++, message, tone, detail };
  for (const l of listeners) l(t);
}

/** Convenience for mutation `onError`: shows the message the API threw. */
export function toastError(label: string, e: unknown): void {
  const detail =
    e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
  toast(label, "error", detail);
}

const TONE_COLOR: Record<ToastTone, string> = {
  error: tokens.bleed,
  info: tokens.info,
  ok: tokens.ok,
};

const TTL_MS: Record<ToastTone, number> = {
  error: 9_000, // long enough to read a stack-ish message
  info: 4_000,
  ok: 3_000,
};

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    const onToast = (t: Toast) => {
      setItems((prev) => [...prev.slice(-4), t]);
      window.setTimeout(
        () => setItems((prev) => prev.filter((x) => x.id !== t.id)),
        TTL_MS[t.tone],
      );
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 44,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 420,
        pointerEvents: "none",
      }}
    >
      {items.map((t) => (
        <div
          key={t.id}
          onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
          style={{
            pointerEvents: "auto",
            cursor: "pointer",
            background: tokens.bgCard,
            border: `1px solid ${TONE_COLOR[t.tone]}`,
            borderLeft: `3px solid ${TONE_COLOR[t.tone]}`,
            borderRadius: 7,
            padding: "9px 12px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
        >
          <div style={{ fontSize: 12, color: tokens.text }}>{t.message}</div>
          {t.detail && (
            <div
              className="mono"
              style={{
                marginTop: 4,
                fontSize: 10.5,
                color: tokens.textMuted,
                wordBreak: "break-word",
              }}
            >
              {t.detail}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
