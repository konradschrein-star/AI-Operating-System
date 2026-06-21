"use client";

import type { ReactNode, CSSProperties } from "react";

interface V2CardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Apply the .v2-card-hover lift effect (accent-tinted edge + translate). */
  hoverable?: boolean;
}

/**
 * V2 Card — neutral surface card with V2 design tokens. Used for stats grids,
 * inbox detail panels, etc. Ported from
 * apps/hub-web/src/app/(authenticated)/_components/v2-card.tsx (v1.6 phase 2).
 *
 * Use {@link GlassCard} when you want the frosted/blur look; V2Card is the
 * solid-surface counterpart.
 */
export function V2Card({ children, className, style, hoverable }: V2CardProps) {
  const cls = ["v2-card", hoverable ? "v2-card-hover" : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      style={{
        background: "var(--v2-surface-1)",
        border: "1px solid var(--v2-border-1)",
        borderRadius: 10,
        padding: 16,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
