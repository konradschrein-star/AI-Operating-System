/**
 * Mobile UI types + semantic color helpers.
 *
 * The shapes here mirror the JSON payloads served by forge-control
 * (see forge-control/src/routes/*.ts). Components receive these types
 * directly from React Query; this module owns the *semantic* mapping
 * (status string → token hex) so component code never touches hex
 * codes and a future theme swap touches one file.
 */

import { tokens } from "./tokens";

export type StatusType = "BLEED" | "STUCK" | "APPROVE" | "DECIDE" | "NORMAL";

export interface TodayChip {
  label: string;
  type: StatusType;
  goto: TabKey;
  animate: boolean;
}

export interface NeedsItem {
  type: string;
  status: StatusType;
  age: string;
  title: string;
}

export interface FleetWorker {
  name: string;
  state: string;
  status: "routing" | "render" | "idle" | "stuck";
}

export interface InboxAction {
  label: string;
  variant: "primary" | "ok" | "danger" | "neutral";
  action_id?: string;
}

export interface InboxTried {
  icon: string;
  text: string;
}

export interface InboxItem {
  id: string;
  type: string;
  status: StatusType;
  age: string;
  title: string;
  ask: string;
  tried: InboxTried[];
  actions: InboxAction[];
}

export interface LiveStat {
  label: string;
  value: string;
  color: string;
}

export interface ServiceDegradation {
  svc: string;
  why: string;
  tier: "L0" | "L1" | "L2" | "L3" | "L4";
}

export interface Provider {
  name: string;
  badge: string;
  status: "ok" | "warn" | "error";
}

export interface FeedbackLoop {
  id: string;
  name: string;
  cadence: string;
  last: string;
  status: "ok" | "warn" | "error" | "info" | "decide";
}

export interface DecisionLogEntry {
  ts: string;
  kind:
    | "dispatch"
    | "breaker"
    | "degrade"
    | "escalate"
    | "unstick"
    | "resolve"
    | "freeze"
    | "resume"
    | "guardrail"
    | "manager"
    | "user";
  action: string;
}

export type TabKey =
  | "today"
  | "inbox"
  | "capture"
  | "live"
  | "control"
  | "auto";

/* ----------------------------------------------------------------------------
 * Semantic color mapping. The ONLY place hex codes are chosen by status.
 * -------------------------------------------------------------------------- */
export const statusColor = (t: StatusType | string): string => {
  switch (t) {
    case "BLEED":
      return tokens.bleed;
    case "STUCK":
      return tokens.stuck;
    case "APPROVE":
      return tokens.ok;
    case "DECIDE":
      return tokens.decide;
    case "ok":
    case "idle":
      return tokens.ok;
    case "warn":
      return tokens.warn;
    case "error":
      return tokens.bleed;
    case "info":
    case "routing":
    case "render":
      return tokens.info;
    case "stuck":
      return tokens.stuck;
    default:
      return tokens.textLabel;
  }
};

export const tierColor = (tier: ServiceDegradation["tier"]): string => {
  switch (tier) {
    case "L0":
      return tokens.ok;
    case "L1":
      return tokens.info;
    case "L2":
      return tokens.accent;
    case "L3":
      return tokens.warn;
    case "L4":
      return tokens.bleed;
  }
};

export const triedIconColor = (icon: string): string => {
  switch (icon) {
    case "close":
      return tokens.bleed;
    case "swap_horiz":
      return tokens.info;
    case "rule":
      return tokens.decide;
    case "block":
      return tokens.stuck;
    default:
      return tokens.textMuted;
  }
};

export const decisionKindColor = (k: DecisionLogEntry["kind"]): string => {
  switch (k) {
    case "dispatch":
      return tokens.info;
    case "breaker":
      return tokens.bleed;
    case "degrade":
      return tokens.warn;
    case "escalate":
      return tokens.stuck;
    case "unstick":
      return tokens.decide;
    case "resolve":
      return tokens.ok;
    case "freeze":
      return tokens.warn;
    case "resume":
      return tokens.ok;
    case "guardrail":
      return tokens.bleed;
    case "manager":
      return tokens.accent;
    case "user":
      return tokens.textLabel;
  }
};

export const loopColor = (s: FeedbackLoop["status"]): string => {
  switch (s) {
    case "error":
      return tokens.bleed;
    case "warn":
      return tokens.warn;
    case "info":
      return tokens.info;
    case "ok":
      return tokens.accent;
    case "decide":
      return tokens.decide;
  }
};

export const providerColor = (s: Provider["status"]): string => {
  switch (s) {
    case "ok":
      return tokens.ok;
    case "warn":
      return tokens.warn;
    case "error":
      return tokens.bleed;
  }
};

/** Color for a Live stat tone reported by the API. */
export const liveStatColor = (
  tone: "accent" | "soft" | "neutral" | "stuck",
): string => {
  switch (tone) {
    case "accent":
      return tokens.accent;
    case "soft":
      return tokens.textSecondary;
    case "neutral":
      return tokens.textLabel;
    case "stuck":
      return tokens.stuck;
  }
};
