import { Hono } from "hono";
import {
  getFleetState,
  listDecisions,
  type DecisionKind,
} from "../db/ai_os.ts";

const r = new Hono();

/**
 * Feedback loops (L1..L5) are part of the AI-OS architecture, not user data.
 * Their cadence/name is fixed; their `last` timestamp is derived from the
 * decision log — the most recent decision of the matching kind.
 */

interface LoopDef {
  id: string;
  name: string;
  cadence: string;
  matches: DecisionKind[];
  tone: "error" | "warn" | "info" | "ok" | "decide";
}

const LOOP_DEFS: LoopDef[] = [
  {
    id: "L1",
    name: "Circuit breakers",
    cadence: "ms",
    matches: ["breaker"],
    tone: "error",
  },
  {
    id: "L2",
    name: "Load balancing",
    cadence: "seconds",
    matches: ["degrade"],
    tone: "warn",
  },
  {
    id: "L3",
    name: "Auto-scaling",
    cadence: "minutes",
    matches: ["dispatch"],
    tone: "info",
  },
  {
    id: "L4",
    name: "Policy adaptation",
    cadence: "hours",
    matches: ["guardrail", "unstick"],
    tone: "ok",
  },
  {
    id: "L5",
    name: "Business rules",
    cadence: "days",
    matches: ["user", "manager"],
    tone: "decide",
  },
];

function humanLast(ts: string | null): string {
  if (!ts) return "—";
  const sec = Math.max(
    0,
    Math.floor((Date.now() - new Date(ts).getTime()) / 1000),
  );
  if (sec < 1) return `${(sec * 1000).toFixed(0)}ms`;
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

r.get("/", async (c) => {
  const fleet = await getFleetState();
  const recent = await listDecisions(200);

  const loops = LOOP_DEFS.map((l) => {
    const lastDecision = recent.find((d) => l.matches.includes(d.kind));
    return {
      id: l.id,
      name: l.name,
      cadence: l.cadence,
      tone: l.tone,
      last: humanLast(lastDecision?.ts ?? null),
    };
  });

  const decisionLog = recent.slice(0, 12).map((d) => ({
    ts: new Date(d.ts).toISOString().substring(11, 16), // HH:MM
    kind: d.kind,
    action: d.action,
  }));

  return c.json({
    fleet,
    loops,
    invariant: {
      label: "Invariant engine",
      sub: "5 hard rules · enforced pre-dispatch",
    },
    decisionLog,
  });
});

export default r;
