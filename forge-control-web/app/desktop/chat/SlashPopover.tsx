"use client";

import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useState,
  useEffect,
  type KeyboardEvent,
} from "react";
import { tokens } from "../../tokens";
import { fuzzyRank } from "./fuzzy";
import { SLASH_COMMANDS, type SlashCommand } from "./slash-registry";

/**
 * Slash autocomplete popover, rendered above the chat composer. v1.6 phase 4.
 *
 * Port of NousResearch/hermes-agent's SlashPopover.tsx (MIT) — same
 * keyboard contract (ArrowUp / ArrowDown / Tab / Enter / Escape) and
 * imperative handle pattern. The parent textarea forwards keys via
 * `ref.handleKey(e)` which returns true when the popover consumed
 * the event. The composer's plain-Enter send logic still runs when
 * the popover is closed.
 *
 * The original hermes-agent version called `gw.request("complete.slash", …)`
 * to get completion items from a remote gateway. This version pulls
 * straight from the local SLASH_COMMANDS registry — no network round
 * trip — and ranks via fuzzyRank.
 */

export interface SlashPopoverHandle {
  /** True if the key was consumed. */
  handleKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
  /** True if popover is currently visible (open + has items). */
  isOpen(): boolean;
  /** Pick the currently-selected command and clear the menu.
   *  Used by the composer when Enter is pressed on an open menu. */
  acceptSelected(): SlashCommand | null;
}

interface Props {
  input: string;
  onApply(item: SlashCommand): void;
}

export const SlashPopover = forwardRef<SlashPopoverHandle, Props>(
  function SlashPopover({ input, onApply }, ref) {
    const [selected, setSelected] = useState(0);

    // Show when input starts with "/" and isn't empty after the slash.
    // Anchored at the end too (no popover for "foo /bar" mid-line).
    const open = input.startsWith("/");
    const query = open ? input.slice(1) : "";

    const ranked = useMemo(() => {
      if (!open) return [];
      return fuzzyRank(SLASH_COMMANDS, query, (c) => `${c.name} ${c.help}`);
    }, [open, query]);

    // Reset highlight when items change.
    useEffect(() => {
      setSelected(0);
    }, [ranked.length, query]);

    const visible = open && ranked.length > 0;

    useImperativeHandle(
      ref,
      () => ({
        isOpen: () => visible,
        acceptSelected: () => {
          if (!visible) return null;
          const cmd = ranked[selected]?.item ?? null;
          if (cmd) onApply(cmd);
          return cmd;
        },
        handleKey: (e) => {
          if (!visible) return false;
          switch (e.key) {
            case "ArrowDown":
              e.preventDefault();
              setSelected((s) => (s + 1) % ranked.length);
              return true;
            case "ArrowUp":
              e.preventDefault();
              setSelected(
                (s) => (s - 1 + ranked.length) % ranked.length,
              );
              return true;
            case "Tab": {
              e.preventDefault();
              const cmd = ranked[selected]?.item;
              if (cmd) onApply(cmd);
              return true;
            }
            case "Escape":
              e.preventDefault();
              return true;
            default:
              return false;
          }
        },
      }),
      [visible, ranked, selected, onApply],
    );

    if (!visible) return null;

    return (
      <div
        role="listbox"
        style={{
          position: "absolute",
          bottom: "calc(100% + 4px)",
          left: 18,
          right: 18,
          maxHeight: 240,
          overflowY: "auto",
          background: tokens.bgCard,
          border: `1px solid ${tokens.borderEmphasis}`,
          borderRadius: 8,
          boxShadow:
            "0 -4px 22px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)",
          fontSize: 12,
          color: tokens.text,
          zIndex: 30,
        }}
      >
        {ranked.map((entry, i) => {
          const active = i === selected;
          return (
            <div
              key={entry.item.name}
              role="option"
              aria-selected={active}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => {
                // Don't blur the textarea on click.
                e.preventDefault();
                onApply(entry.item);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 12px",
                cursor: "pointer",
                background: active
                  ? "rgba(var(--v2-accent-rgb), 0.12)"
                  : "transparent",
                borderLeft: `2px solid ${active ? "var(--v2-accent)" : "transparent"}`,
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: active ? "var(--v2-accent)" : tokens.textLabel,
                  flex: "none",
                  minWidth: 110,
                }}
              >
                /{entry.item.name}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: active ? tokens.textHi : tokens.textMuted,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.item.help}
              </span>
            </div>
          );
        })}
        <div
          className="mono"
          style={{
            padding: "5px 12px",
            fontSize: 9.5,
            color: tokens.textFaint,
            borderTop: `1px solid ${tokens.borderDivider}`,
            letterSpacing: "0.06em",
          }}
        >
          ↑↓ navigate · Tab/Enter accept · Esc cancel
        </div>
      </div>
    );
  },
);
