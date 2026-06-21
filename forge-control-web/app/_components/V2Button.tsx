"use client";

import type { ReactNode, CSSProperties, MouseEventHandler } from "react";

type V2ButtonVariant =
  | "default"
  | "accent"
  | "outline"
  | "ghost"
  | "warn"
  | "danger";
type V2ButtonSize = "sm" | "md" | "lg";

interface V2ButtonProps {
  children: ReactNode;
  variant?: V2ButtonVariant;
  size?: V2ButtonSize;
  className?: string;
  style?: CSSProperties;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  title?: string;
}

/**
 * V2 Button — ported from apps/hub-web/src/app/(authenticated)/_components/v2-button.tsx
 * (v1.6 phase 2). The variant maps to a v2.css class (.v2-btn / .v2-btn-accent /
 * .v2-btn-outline / .v2-btn-ghost / .v2-btn-warn / .v2-btn-danger). Sizes override
 * font-size/padding via inline style so we don't add another set of CSS classes.
 *
 * Hub-web's original was Tailwind-heavy; this version is inline-style-only to
 * match the forge-control-web V2 inline-style mandate (see CLAUDE.md memory).
 */
export function V2Button({
  children,
  variant = "default",
  size = "md",
  className,
  style,
  onClick,
  disabled,
  type = "button",
  title,
}: V2ButtonProps) {
  const variantClass: Record<V2ButtonVariant, string> = {
    default: "v2-btn",
    accent: "v2-btn-accent",
    outline: "v2-btn-outline",
    ghost: "v2-btn-ghost",
    warn: "v2-btn-warn",
    danger: "v2-btn-danger",
  };
  const sizeStyle: Record<V2ButtonSize, CSSProperties> = {
    sm: { padding: "4px 10px", fontSize: 10 },
    md: {},
    lg: { padding: "10px 22px", fontSize: 13 },
  };
  const cls = [variantClass[variant], className].filter(Boolean).join(" ");
  return (
    <button
      type={type}
      className={cls}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ ...sizeStyle[size], ...style }}
    >
      {children}
    </button>
  );
}
