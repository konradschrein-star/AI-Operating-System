"use client";

import type { ReactNode, CSSProperties, MouseEventHandler } from "react";

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: MouseEventHandler<HTMLDivElement>;
}

/**
 * Frosted card primitive lifted from apps/hub-web/src/app/(authenticated)/_components/glass-card.tsx
 * (v1.6 phase 2). Same defaults; backdrop-filter blur 20px + low-opacity
 * white background + thin border. Composes with `.v2-card-hover` for
 * accent-tinted edge lighting on hover.
 */
export function GlassCard({
  children,
  className = "",
  style,
  onClick,
}: GlassCardProps) {
  return (
    <div
      className={className}
      onClick={onClick}
      style={{
        background: "rgba(255, 255, 255, 0.04)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: "1px solid rgba(255, 255, 255, 0.09)",
        borderRadius: 12,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
