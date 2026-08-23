"use client";

import { useMemo, useState, useEffect, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens, dot } from "../tokens";
import {
  fetchAutonomy,
  updateRule,
  freezeFleet,
  resumeFleet,
  resolveTrip,
  type GuardrailRule,
  type GuardrailTrip,
} from "../api";

const CATEGORY_COLOR: Record<string, string> = {
  financial: tokens.warn,
  destructive: tokens.bleed,
  communication: tokens.info,
  security: tokens.decide,
  deployment: tokens.accent,
  custom: tokens.textMuted,
};

const CATEGORY_LABEL: Record<string, string> = {
  financial: "Money",
  destructive: "Destructive",
  communication: "Outbound comms",
  security: "Security",
  deployment: "Deploy / prod",
  custom: "Custom",
};

const CATEGORY_ICON: Record<string, string> = {
  financial: "payments",
  destructive: "warning",
  communication: "chat",
  security: "shield",
  deployment: "rocket_launch",
  custom: "tune",
};

function humanAge(ts: string | null | undefined): string {
  if (!ts) return "—";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function inferTripCategory(
  trip: GuardrailTrip,
  ruleCategoryMap: Map<string, string>,
): string {
  if (ruleCategoryMap.has(trip.rule_id)) {
    return ruleCategoryMap.get(trip.rule_id)!;
  }
  const id = (trip.rule_id || "").toLowerCase();
  const act = (trip.attempted_action || "").toLowerCase();
  if (id.startsWith("spend.") || act.includes("spend")) return "financial";
  if (
    id.startsWith("fs.") ||
    id.startsWith("git.") ||
    act.includes("destructive") ||
    act.includes("force_push")
  ) {
    return "destructive";
  }
  if (
    id.startsWith("comm.") ||
    act.includes("message") ||
    act.includes("slack") ||
    act.includes("email")
  ) {
    return "communication";
  }
  if (id.startsWith("deploy.") || act.includes("deploy")) return "deployment";
  if (
    id.startsWith("runtime.") ||
    id.startsWith("agent.") ||
    id.startsWith("secrets.") ||
    act.includes("pause")
  ) {
    return "security";
  }
  return "custom";
}

function getEngineBadge(trip: GuardrailTrip): { label: string; color: string } {
  const p = trip.payload ?? {};
  const model = typeof p.model === "string" ? p.model.toLowerCase() : "";
  const engine = typeof p.engine === "string" ? p.engine.toLowerCase() : "";
  const act = (trip.attempted_action || "").toLowerCase();
  const agent = (trip.agent || "").toLowerCase();

  if (
    model.includes("gemini") ||
    engine.includes("gemini") ||
    act.includes("gemini")
  ) {
    return { label: "Gemini", color: tokens.decide };
  }
  if (model.includes("opus")) {
    return { label: "Claude Opus", color: tokens.accent };
  }
  if (model.includes("sonnet")) {
    return { label: "Claude Sonnet", color: tokens.accent };
  }
  if (model.includes("haiku")) {
    return { label: "Claude Haiku", color: tokens.accent };
  }
  if (
    act.includes("claude-pool") ||
    act.includes("claude") ||
    engine.includes("claude")
  ) {
    return { label: "Claude", color: tokens.accent };
  }
  if (
    agent.includes("smoke") ||
    agent.includes("probe") ||
    act.includes("probe")
  ) {
    return { label: "Probe", color: tokens.textMuted };
  }
  if (agent.includes("executor")) {
    return { label: "forge-executor", color: tokens.info };
  }
  return { label: trip.agent || "Worker", color: tokens.textMuted };
}

interface TripMetric {
  label: string;
  value: string;
  isSpend?: boolean;
}

function extractTripMetrics(trip: GuardrailTrip): TripMetric[] {
  const p = trip.payload ?? {};
  const list: TripMetric[] = [];

  if (p.spend_eur !== undefined && p.spend_eur !== null) {
    const val = Number(p.spend_eur);
    if (!Number.isNaN(val)) {
      list.push({
        label: "Spend",
        value: `€${val.toFixed(2)}`,
        isSpend: true,
      });
    }
  }

  if (p.daily_spend_eur !== undefined && p.daily_spend_eur !== null) {
    const val = Number(p.daily_spend_eur);
    if (!Number.isNaN(val)) {
      list.push({
        label: "Daily Spend",
        value: `€${val.toFixed(2)}`,
      });
    }
  }

  if (p.thread_chars !== undefined && p.thread_chars !== null) {
    const chars = Number(p.thread_chars);
    if (!Number.isNaN(chars) && chars > 0) {
      if (chars >= 1_000_000) {
        list.push({
          label: "Thread",
          value: `${(chars / 1_000_000).toFixed(2)}M chars`,
        });
      } else {
        list.push({
          label: "Thread",
          value: `${Math.round(chars / 1000)}k chars`,
        });
      }
    }
  }

  if (p.tokens !== undefined && p.tokens !== null) {
    const tok = Number(p.tokens);
    if (!Number.isNaN(tok)) {
      list.push({
        label: "Tokens",
        value: `${tok.toLocaleString()}`,
      });
    }
  }

  if (p.active_workers !== undefined && p.active_workers !== null) {
    list.push({
      label: "Active Workers",
      value: `${p.active_workers}`,
    });
  }

  if (typeof p.branch === "string" && p.branch) {
    list.push({
      label: "Branch",
      value: p.branch,
    });
  }

  return list;
}

export function AutonomySurface() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["autonomy"],
    queryFn: fetchAutonomy,
    refetchInterval: 8000,
  });

  const [cat, setCat] = useState<string | null>(null);
  const [tripStatusFilter, setTripStatusFilter] = useState<
    "all" | "unresolved" | "resolved"
  >("all");
  const [resolvingTripId, setResolvingTripId] = useState<string | null>(null);
  const [savingRuleId, setSavingRuleId] = useState<string | null>(null);

  const freezeM = useMutation({
    mutationFn: async () => {
      if (q.data?.fleet.status === "paused") {
        return resumeFleet("user");
      }
      return freezeFleet("user");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["autonomy"] });
    },
  });

  const ruleToggleM = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      return updateRule(id, { enabled });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["autonomy"] });
    },
  });

  const ruleConfigM = useMutation({
    mutationFn: async ({
      id,
      config,
    }: {
      id: string;
      config: Record<string, unknown>;
    }) => {
      setSavingRuleId(id);
      return updateRule(id, { config });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["autonomy"] });
    },
    onSettled: () => {
      setSavingRuleId(null);
    },
  });

  const resolveTripM = useMutation({
    mutationFn: async (tripId: string) => {
      setResolvingTripId(tripId);
      return resolveTrip(tripId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["autonomy"] });
    },
    onSettled: () => {
      setResolvingTripId(null);
    },
  });

  const ruleCategoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of q.data?.rules ?? []) {
      map.set(r.id, r.category);
    }
    return map;
  }, [q.data?.rules]);

  const filteredRules = useMemo<GuardrailRule[]>(() => {
    const all = q.data?.rules ?? [];
    return cat ? all.filter((r) => r.category === cat) : all;
  }, [q.data?.rules, cat]);

  const allCategoryTrips = useMemo<GuardrailTrip[]>(() => {
    const all = q.data?.trips ?? [];
    return cat
      ? all.filter((t) => inferTripCategory(t, ruleCategoryMap) === cat)
      : all;
  }, [q.data?.trips, cat, ruleCategoryMap]);

  const filteredTrips = useMemo<GuardrailTrip[]>(() => {
    if (tripStatusFilter === "unresolved") {
      return allCategoryTrips.filter((t) => !t.resolved);
    }
    if (tripStatusFilter === "resolved") {
      return allCategoryTrips.filter((t) => t.resolved);
    }
    return allCategoryTrips;
  }, [allCategoryTrips, tripStatusFilter]);

  const unresolvedTripCount = useMemo(() => {
    return allCategoryTrips.filter((t) => !t.resolved).length;
  }, [allCategoryTrips]);

  const resolvedTripCount = useMemo(() => {
    return allCategoryTrips.filter((t) => t.resolved).length;
  }, [allCategoryTrips]);

  // Loading state
  if (q.isLoading && !q.data) {
    return <AutonomySkeleton />;
  }

  // Error state
  if (q.isError && !q.data) {
    return (
      <AutonomyError
        error={q.error as Error}
        onRetry={() => q.refetch()}
      />
    );
  }

  const paused = q.data?.fleet.status === "paused";
  const rules = q.data?.rules ?? [];
  const trips = q.data?.trips ?? [];

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Category Rail */}
      <div
        style={{
          width: 220,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          padding: "14px 0",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
            padding: "0 16px 10px",
          }}
        >
          GUARDRAIL CATEGORIES
        </div>

        <CatItem
          label="ALL POLICIES"
          count={rules.length}
          tripCount={trips.length}
          active={!cat}
          onClick={() => setCat(null)}
        />

        {q.data?.categories.map((c) => {
          const catTripsCount = trips.filter(
            (t) => inferTripCategory(t, ruleCategoryMap) === c.key,
          ).length;
          return (
            <CatItem
              key={c.key}
              label={c.label || CATEGORY_LABEL[c.key] || c.key}
              count={c.count}
              tripCount={catTripsCount}
              active={cat === c.key}
              onClick={() => setCat(c.key)}
              color={CATEGORY_COLOR[c.key]}
              icon={CATEGORY_ICON[c.key]}
            />
          );
        })}

        <div style={{ flex: 1 }} />

        {/* Fleet telemetry summary in rail */}
        <div
          style={{
            padding: "12px 16px",
            borderTop: `1px solid ${tokens.borderDivider}`,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            className="mono"
            style={{ fontSize: 9.5, color: tokens.textFaint, letterSpacing: "0.08em" }}
          >
            FLEET STATE
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={dot(paused ? tokens.warn : tokens.ok, paused)} />
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: paused ? tokens.warn : tokens.ok,
              }}
            >
              {paused ? "Frozen" : "Operational"}
            </span>
          </div>
          {q.data?.fleet.updated_at && (
            <div
              className="mono"
              style={{ fontSize: 9.5, color: tokens.textFaint, marginTop: 2 }}
            >
              Updated {humanAge(q.data.fleet.updated_at)}
            </div>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          padding: "18px 24px 40px",
        }}
      >
        {/* Synchronized Fleet Freeze Hero */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            border: `1.5px solid ${paused ? tokens.freezeBorderWarn : tokens.freezeBorderOk}`,
            background: paused ? tokens.freezeBgWarn : tokens.freezeBgOk,
            borderRadius: 12,
            padding: "16px 20px",
            marginBottom: 24,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: paused ? tokens.dangerActionBg : tokens.okActionBg,
              border: `1px solid ${paused ? tokens.freezeBorderWarn : tokens.freezeBorderOk}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
            }}
          >
            <span
              className="ms"
              style={{ fontSize: 26, color: paused ? tokens.warn : tokens.ok }}
            >
              {paused ? "ac_unit" : "bolt"}
            </span>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: paused ? tokens.warn : tokens.ok,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span>{paused ? "Fleet is FROZEN" : "Fleet is running"}</span>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: paused ? tokens.warn : tokens.ok,
                  border: `1px solid ${paused ? tokens.freezeBorderWarn : tokens.freezeBorderOk}`,
                  padding: "1px 6px",
                  borderRadius: 4,
                  textTransform: "uppercase",
                }}
              >
                {paused ? "Emergency Stop Active" : "Dispatch Active"}
              </span>
            </div>
            <div
              style={{
                fontSize: 12,
                color: tokens.textSecondary,
                marginTop: 3,
                lineHeight: 1.4,
              }}
            >
              {paused
                ? "All worker task dispatches are currently blocked across Claude and Gemini runners."
                : "Workers are actively dispatched according to configured guardrail policies."}
              {q.data?.fleet.updated_at && (
                <span style={{ color: tokens.textFaint }}>
                  {" "}
                  · State updated {humanAge(q.data.fleet.updated_at)} by{" "}
                  {q.data.fleet.updated_by || "system"}
                </span>
              )}
            </div>
          </div>

          <button
            onClick={() => freezeM.mutate()}
            disabled={freezeM.isPending}
            style={{
              fontSize: 12,
              fontWeight: 700,
              borderRadius: 8,
              padding: "9px 18px",
              cursor: freezeM.isPending ? "not-allowed" : "pointer",
              border: `1px solid ${paused ? tokens.okActionBorder : tokens.freezeBorderWarn}`,
              color: paused ? tokens.textHi : tokens.freezeBgWarn,
              background: paused ? tokens.ok : tokens.warn,
              display: "flex",
              alignItems: "center",
              gap: 6,
              transition: "opacity 0.15s",
              opacity: freezeM.isPending ? 0.6 : 1,
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>
              {paused ? "play_arrow" : "pause"}
            </span>
            <span>
              {freezeM.isPending
                ? "Updating..."
                : paused
                  ? "Resume Fleet"
                  : "FREEZE FLEET"}
            </span>
          </button>
        </div>

        {/* Policies Section */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              color: tokens.textFaint,
              letterSpacing: "0.1em",
            }}
          >
            POLICIES — {filteredRules.length} {cat ? cat.toUpperCase() : "ALL"}
          </div>

          {cat && (
            <button
              onClick={() => setCat(null)}
              style={{
                fontSize: 10.5,
                color: tokens.accent,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "2px 6px",
              }}
            >
              Clear Category Filter
            </button>
          )}
        </div>

        {filteredRules.length === 0 ? (
          <div
            style={{
              background: tokens.bgCard,
              border: `1px dashed ${tokens.border}`,
              borderRadius: 8,
              padding: "22px 18px",
              fontSize: 12,
              color: tokens.textFaint,
              textAlign: "center",
              marginBottom: 28,
            }}
          >
            No guardrail policies found in category &ldquo;{cat}&rdquo;.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              marginBottom: 32,
            }}
          >
            {filteredRules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                isSaving={savingRuleId === rule.id}
                onToggle={() =>
                  ruleToggleM.mutate({ id: rule.id, enabled: !rule.enabled })
                }
                onSaveConfig={async (newConfig) => {
                  await ruleConfigM.mutateAsync({
                    id: rule.id,
                    config: newConfig,
                  });
                }}
              />
            ))}
          </div>
        )}

        {/* Recent Incident Trips Section */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                color: tokens.textFaint,
                letterSpacing: "0.1em",
              }}
            >
              RECENT TRIPS — {allCategoryTrips.length} {cat ? cat.toUpperCase() : "ALL"}
            </div>
            {unresolvedTripCount > 0 && (
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  padding: "1px 6px",
                  borderRadius: 4,
                  background: tokens.dangerActionBg,
                  border: `1px solid ${tokens.dangerActionBorder}`,
                  color: tokens.bleed,
                }}
              >
                {unresolvedTripCount} unresolved
              </span>
            )}
          </div>

          {/* Status Filter Tabs */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: tokens.bgGutter,
              border: `1px solid ${tokens.borderDivider}`,
              borderRadius: 6,
              padding: 2,
            }}
          >
            <StatusTab
              label="All"
              count={allCategoryTrips.length}
              active={tripStatusFilter === "all"}
              onClick={() => setTripStatusFilter("all")}
            />
            <StatusTab
              label="Unresolved"
              count={unresolvedTripCount}
              active={tripStatusFilter === "unresolved"}
              color={tokens.bleed}
              onClick={() => setTripStatusFilter("unresolved")}
            />
            <StatusTab
              label="Resolved"
              count={resolvedTripCount}
              active={tripStatusFilter === "resolved"}
              color={tokens.ok}
              onClick={() => setTripStatusFilter("resolved")}
            />
          </div>
        </div>

        {filteredTrips.length === 0 ? (
          <div
            className="mono"
            style={{
              background: tokens.bgCard,
              border: `1px dashed ${tokens.border}`,
              borderRadius: 8,
              padding: 22,
              fontSize: 11.5,
              color: tokens.textFaint,
              textAlign: "center",
            }}
          >
            {tripStatusFilter === "unresolved"
              ? "All guardrail trip incidents in this view are resolved."
              : "No guardrail trips recorded for this selection — all dispatches operating within bounds."}
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {filteredTrips.map((t) => (
              <TripRow
                key={t.id}
                trip={t}
                isResolving={resolvingTripId === t.id}
                onResolve={() => resolveTripM.mutate(t.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Rule Row with Dedicated Editable Configuration Controls
 * -------------------------------------------------------------------------- */
function RuleRow({
  rule,
  onToggle,
  onSaveConfig,
  isSaving,
}: {
  rule: GuardrailRule;
  onToggle: () => void;
  onSaveConfig: (config: Record<string, unknown>) => Promise<void>;
  isSaving: boolean;
}) {
  const color = CATEGORY_COLOR[rule.category] ?? tokens.textMuted;
  const [draftConfig, setDraftConfig] = useState<Record<string, unknown>>(() => ({
    ...(rule.config ?? {}),
  }));
  const [savedRecently, setSavedRecently] = useState(false);
  const [newBranchInput, setNewBranchInput] = useState("");
  const [showAddCustomField, setShowAddCustomField] = useState(false);
  const [customKey, setCustomKey] = useState("");
  const [customVal, setCustomVal] = useState("");

  // Sync draft when rule.config updates from server
  useEffect(() => {
    setDraftConfig({ ...(rule.config ?? {}) });
  }, [rule.config]);

  const isDirty = useMemo(() => {
    const orig = JSON.stringify(rule.config ?? {});
    const curr = JSON.stringify(draftConfig);
    return orig !== curr;
  }, [draftConfig, rule.config]);

  const handleSave = async () => {
    await onSaveConfig(draftConfig);
    setSavedRecently(true);
    setTimeout(() => setSavedRecently(false), 2200);
  };

  const handleDiscard = () => {
    setDraftConfig({ ...(rule.config ?? {}) });
    setShowAddCustomField(false);
  };

  const setConfigValue = (key: string, value: unknown) => {
    setDraftConfig((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const removeConfigKey = (key: string) => {
    setDraftConfig((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const protectedBranches = Array.isArray(draftConfig.protected_branches)
    ? (draftConfig.protected_branches as string[])
    : [];

  const addProtectedBranch = (branch: string) => {
    const trimmed = branch.trim();
    if (!trimmed || protectedBranches.includes(trimmed)) return;
    setConfigValue("protected_branches", [...protectedBranches, trimmed]);
    setNewBranchInput("");
  };

  const removeProtectedBranch = (branch: string) => {
    setConfigValue(
      "protected_branches",
      protectedBranches.filter((b) => b !== branch),
    );
  };

  const addCustomParameter = () => {
    const k = customKey.trim();
    if (!k) return;
    let v: unknown = customVal.trim();
    // Parse number or json if applicable
    if (!Number.isNaN(Number(v)) && v !== "") {
      v = Number(v);
    } else if (v === "true") {
      v = true;
    } else if (v === "false") {
      v = false;
    }
    setConfigValue(k, v);
    setCustomKey("");
    setCustomVal("");
    setShowAddCustomField(false);
  };

  // Known config keys for specific rules
  const isDailyCap = rule.id === "spend.daily_cap";
  const isPerRunCap = rule.id === "spend.per_run_cap";
  const isSpawnCap = rule.id === "agent.spawn_cap";
  const isGitForcePush = rule.id === "git.force_push";

  const handledKeys = new Set<string>();
  if (isDailyCap) handledKeys.add("cap_eur");
  if (isPerRunCap) {
    handledKeys.add("cap_eur");
    handledKeys.add("gemini_token_cap");
    handledKeys.add("claude_token_cap");
    handledKeys.add("tokens_per_run_cap");
    handledKeys.add("token_cap");
  }
  if (isSpawnCap) handledKeys.add("max");
  if (isGitForcePush) handledKeys.add("protected_branches");

  const unhandledKeys = Object.keys(draftConfig).filter(
    (k) => !handledKeys.has(k),
  );

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${rule.enabled ? tokens.border : tokens.borderDivider}`,
        borderLeft: `3px solid ${rule.enabled ? color : tokens.borderDivider}`,
        borderRadius: 8,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        opacity: rule.enabled ? 1 : 0.68,
        transition: "border-color 0.15s, opacity 0.15s",
      }}
    >
      {/* Header Line */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span
              className="mono"
              style={{
                fontSize: 9.5,
                color,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              {rule.category}
            </span>
            <span
              className="mono"
              style={{ fontSize: 10, color: tokens.textFaint }}
            >
              · {rule.id}
            </span>
            {rule.builtin && (
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: tokens.textFaint,
                  border: `1px solid ${tokens.borderDivider}`,
                  borderRadius: 4,
                  padding: "0 5px",
                }}
              >
                builtin
              </span>
            )}
          </div>

          <div
            style={{
              fontSize: 13.5,
              color: tokens.textHi,
              marginTop: 4,
              fontWeight: 600,
            }}
          >
            {rule.label}
          </div>

          <div
            style={{
              fontSize: 12,
              color: tokens.textSecondary,
              marginTop: 3,
              lineHeight: 1.4,
            }}
          >
            {rule.description}
          </div>
        </div>

        <Toggle on={rule.enabled} onClick={onToggle} color={color} />
      </div>

      {/* Config Editor Controls */}
      <div
        style={{
          background: tokens.bgGutter,
          border: `1px solid ${tokens.borderDivider}`,
          borderRadius: 6,
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            className="mono"
            style={{ fontSize: 9.5, color: tokens.textFaint, letterSpacing: "0.06em" }}
          >
            CONFIGURATION PARAMETERS
          </div>

          {!showAddCustomField && (
            <button
              onClick={() => setShowAddCustomField(true)}
              style={{
                fontSize: 10,
                color: tokens.accent,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
              }}
            >
              + Add Parameter
            </button>
          )}
        </div>

        {/* Specific Parameter Editors */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {isDailyCap && (
            <NumberControl
              label="Daily Hard Cap (€)"
              value={Number(draftConfig.cap_eur ?? 100)}
              step={10}
              min={1}
              onChange={(val) => setConfigValue("cap_eur", val)}
              onEnter={handleSave}
            />
          )}

          {isPerRunCap && (
            <>
              <NumberControl
                label="Per-Run Claude Cap (€)"
                value={Number(draftConfig.cap_eur ?? 50)}
                step={5}
                min={1}
                onChange={(val) => setConfigValue("cap_eur", val)}
                onEnter={handleSave}
              />
              <NumberControl
                label="Gemini Token Cap"
                value={Number(
                  draftConfig.gemini_token_cap ??
                    draftConfig.token_cap ??
                    1000000,
                )}
                step={100000}
                min={10000}
                onChange={(val) => setConfigValue("gemini_token_cap", val)}
                onEnter={handleSave}
              />
              <NumberControl
                label="Claude Token Cap"
                value={
                  draftConfig.claude_token_cap !== undefined
                    ? Number(draftConfig.claude_token_cap)
                    : 100000
                }
                step={25000}
                min={10000}
                onChange={(val) => setConfigValue("claude_token_cap", val)}
                onEnter={handleSave}
              />
            </>
          )}

          {isSpawnCap && (
            <NumberControl
              label="Max Concurrent Workers"
              value={Number(draftConfig.max ?? 8)}
              step={1}
              min={1}
              max={64}
              onChange={(val) => setConfigValue("max", val)}
              onEnter={handleSave}
            />
          )}

          {isGitForcePush && (
            <div style={{ flex: "1 1 100%", display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 10.5, color: tokens.textSecondary }}>
                Protected Branches:
              </span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                {protectedBranches.map((branch) => (
                  <span
                    key={branch}
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: tokens.textHi,
                      background: tokens.bgCard,
                      border: `1px solid ${tokens.border}`,
                      borderRadius: 4,
                      padding: "2px 8px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span>{branch}</span>
                    <button
                      onClick={() => removeProtectedBranch(branch)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: tokens.textFaint,
                        cursor: "pointer",
                        padding: 0,
                        fontSize: 12,
                        lineHeight: 1,
                      }}
                      title={`Remove branch ${branch}`}
                    >
                      ✕
                    </button>
                  </span>
                ))}

                <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="text"
                    value={newBranchInput}
                    placeholder="branch name"
                    onChange={(e) => setNewBranchInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addProtectedBranch(newBranchInput);
                      }
                    }}
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: tokens.text,
                      background: tokens.inputBg,
                      border: `1px solid ${tokens.border}`,
                      borderRadius: 4,
                      padding: "3px 8px",
                      width: 110,
                      outline: "none",
                    }}
                  />
                  <button
                    onClick={() => addProtectedBranch(newBranchInput)}
                    disabled={!newBranchInput.trim()}
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      color: tokens.textHi,
                      background: tokens.primaryActionBg,
                      border: `1px solid ${tokens.accent}`,
                      borderRadius: 4,
                      padding: "3px 8px",
                      cursor: newBranchInput.trim() ? "pointer" : "default",
                      opacity: newBranchInput.trim() ? 1 : 0.5,
                    }}
                  >
                    + Add
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Unhandled arbitrary keys for custom or extensible rules */}
          {unhandledKeys.map((k) => {
            const val = draftConfig[k];
            if (typeof val === "number") {
              return (
                <NumberControl
                  key={k}
                  label={k}
                  value={val}
                  onChange={(newVal) => setConfigValue(k, newVal)}
                  onEnter={handleSave}
                  onRemove={() => removeConfigKey(k)}
                />
              );
            }
            return (
              <div
                key={k}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="mono" style={{ fontSize: 10.5, color: tokens.textSecondary }}>
                    {k}
                  </span>
                  <button
                    onClick={() => removeConfigKey(k)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: tokens.textFaint,
                      cursor: "pointer",
                      fontSize: 10,
                      padding: 0,
                    }}
                  >
                    ✕
                  </button>
                </div>
                <input
                  type="text"
                  value={
                    typeof val === "object" ? JSON.stringify(val) : String(val ?? "")
                  }
                  onChange={(e) => setConfigValue(k, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                  }}
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: tokens.text,
                    background: tokens.inputBg,
                    border: `1px solid ${tokens.border}`,
                    borderRadius: 4,
                    padding: "4px 8px",
                    outline: "none",
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* Add Custom Parameter Input */}
        {showAddCustomField && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 8px",
              background: tokens.bgCard,
              border: `1px solid ${tokens.borderDivider}`,
              borderRadius: 6,
              marginTop: 4,
            }}
          >
            <input
              type="text"
              placeholder="key (e.g. timeout_sec)"
              value={customKey}
              onChange={(e) => setCustomKey(e.target.value)}
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.text,
                background: tokens.inputBg,
                border: `1px solid ${tokens.border}`,
                borderRadius: 4,
                padding: "3px 6px",
                width: 140,
                outline: "none",
              }}
            />
            <input
              type="text"
              placeholder="value (e.g. 300)"
              value={customVal}
              onChange={(e) => setCustomVal(e.target.value)}
              className="mono"
              style={{
                fontSize: 11,
                color: tokens.text,
                background: tokens.inputBg,
                border: `1px solid ${tokens.border}`,
                borderRadius: 4,
                padding: "3px 6px",
                width: 140,
                outline: "none",
              }}
            />
            <button
              onClick={addCustomParameter}
              disabled={!customKey.trim()}
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: tokens.textHi,
                background: tokens.primaryActionBg,
                border: `1px solid ${tokens.accent}`,
                borderRadius: 4,
                padding: "4px 8px",
                cursor: customKey.trim() ? "pointer" : "default",
              }}
            >
              Add
            </button>
            <button
              onClick={() => setShowAddCustomField(false)}
              style={{
                fontSize: 10.5,
                color: tokens.textFaint,
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Inline Save / Feedback Toolbar */}
        {(isDirty || savedRecently || isSaving) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 8,
              paddingTop: 4,
              borderTop: `1px solid ${tokens.borderDivider}`,
            }}
          >
            {savedRecently && (
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: tokens.ok,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span className="ms" style={{ fontSize: 14 }}>
                  check
                </span>
                Saved
              </span>
            )}

            {isDirty && (
              <>
                <button
                  onClick={handleDiscard}
                  disabled={isSaving}
                  style={{
                    fontSize: 11,
                    color: tokens.textSecondary,
                    background: "transparent",
                    border: `1px solid ${tokens.border}`,
                    borderRadius: 5,
                    padding: "4px 10px",
                    cursor: isSaving ? "not-allowed" : "pointer",
                  }}
                >
                  Discard
                </button>
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: tokens.textHi,
                    background: tokens.accent,
                    border: `1px solid ${tokens.accent}`,
                    borderRadius: 5,
                    padding: "4px 12px",
                    cursor: isSaving ? "not-allowed" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span>{isSaving ? "Saving..." : "Save Config"}</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Helper: Number Config Input Control
 * -------------------------------------------------------------------------- */
function NumberControl({
  label,
  value,
  step = 1,
  min,
  max,
  onChange,
  onEnter,
  onRemove,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (val: number) => void;
  onEnter?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="mono" style={{ fontSize: 10.5, color: tokens.textSecondary }}>
          {label}
        </span>
        {onRemove && (
          <button
            onClick={onRemove}
            style={{
              background: "transparent",
              border: "none",
              color: tokens.textFaint,
              cursor: "pointer",
              fontSize: 10,
              padding: 0,
            }}
          >
            ✕
          </button>
        )}
      </div>
      <input
        type="number"
        value={Number.isNaN(value) ? "" : value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
        className="mono"
        style={{
          fontSize: 11.5,
          color: tokens.textHi,
          background: tokens.inputBg,
          border: `1px solid ${tokens.border}`,
          borderRadius: 4,
          padding: "4px 8px",
          width: 140,
          outline: "none",
        }}
      />
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Incident Trip Card with Diagnostic Reason, Metrics, Engine Badge, Resolve Action
 * -------------------------------------------------------------------------- */
function TripRow({
  trip,
  isResolving,
  onResolve,
}: {
  trip: GuardrailTrip;
  isResolving: boolean;
  onResolve: () => void;
}) {
  const engine = getEngineBadge(trip);
  const metrics = extractTripMetrics(trip);
  const p = trip.payload ?? {};
  const reason = typeof p._reason === "string" ? p._reason : null;
  const runId = typeof p.run_id === "string" ? p.run_id : null;

  return (
    <div
      style={{
        background: tokens.bgCard,
        border: `1px solid ${trip.resolved ? tokens.borderDivider : tokens.border}`,
        borderRadius: 8,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Header Row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={dot(trip.resolved ? tokens.ok : tokens.bleed)} />

        <span
          className="mono"
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: tokens.textHi,
          }}
        >
          {trip.rule_label || trip.rule_id}
        </span>

        {/* Engine Badge */}
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            color: engine.color,
            border: `1px solid ${tokens.borderDivider}`,
            background: tokens.bgGutter,
            borderRadius: 4,
            padding: "1px 6px",
          }}
        >
          {engine.label}
        </span>

        <span
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
          }}
        >
          {trip.attempted_action}
        </span>

        <span style={{ flex: 1 }} />

        <span
          className="mono"
          style={{ fontSize: 10, color: tokens.textFaint }}
          title={trip.ts}
        >
          {humanAge(trip.ts)}
        </span>
      </div>

      {/* Diagnostic Reason Banner */}
      {reason && (
        <div
          style={{
            background: tokens.bgGutter,
            border: `1px solid ${tokens.borderDivider}`,
            borderRadius: 6,
            padding: "7px 10px",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <span
            className="ms"
            style={{
              fontSize: 16,
              color: trip.resolved ? tokens.ok : tokens.bleed,
              marginTop: 1,
            }}
          >
            {trip.resolved ? "verified" : "error_outline"}
          </span>
          <div
            className="mono"
            style={{
              fontSize: 11.5,
              color: tokens.textHi,
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
          >
            {reason}
          </div>
        </div>
      )}

      {/* Metrics Row */}
      {metrics.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {metrics.map((m, idx) => (
            <span
              key={idx}
              className="mono"
              style={{
                fontSize: 10.5,
                background: m.isSpend ? tokens.dangerActionBg : tokens.bgGutter,
                border: `1px solid ${m.isSpend ? tokens.dangerActionBorder : tokens.borderDivider}`,
                color: m.isSpend ? tokens.warn : tokens.textSecondary,
                borderRadius: 4,
                padding: "2px 7px",
              }}
            >
              <span style={{ color: tokens.textFaint }}>{m.label}: </span>
              {m.value}
            </span>
          ))}
        </div>
      )}

      {/* Footer Actions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 4,
          borderTop: `1px solid ${tokens.borderDivider}`,
          marginTop: 2,
        }}
      >
        {runId ? (
          <a
            href={`/desktop?surface=chat&chat=${encodeURIComponent(runId)}`}
            style={{
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              color: tokens.accent,
              background: tokens.primaryActionBg,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 5,
              padding: "3px 8px",
            }}
          >
            <span className="ms" style={{ fontSize: 13 }}>
              chat
            </span>
            <span>View Run in Chat ↗</span>
          </a>
        ) : (
          <div />
        )}

        {trip.resolved ? (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              color: tokens.ok,
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>
              check_circle
            </span>
            <span>Resolved</span>
            {trip.resolution_note && (
              <span style={{ color: tokens.textFaint }}>
                {" "}
                · {trip.resolution_note}
              </span>
            )}
          </div>
        ) : (
          <button
            onClick={onResolve}
            disabled={isResolving}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              fontWeight: 600,
              color: tokens.ok,
              background: tokens.okActionBg,
              border: `1px solid ${tokens.okActionBorder}`,
              borderRadius: 5,
              padding: "4px 10px",
              cursor: isResolving ? "not-allowed" : "pointer",
              transition: "opacity 0.15s",
              opacity: isResolving ? 0.6 : 1,
            }}
          >
            <span className="ms" style={{ fontSize: 14 }}>
              check
            </span>
            <span>{isResolving ? "Resolving..." : "Resolve Incident"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Status Filter Tab Button
 * -------------------------------------------------------------------------- */
function StatusTab({
  label,
  count,
  active,
  color,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        color: active ? tokens.textHi : tokens.textMuted,
        background: active ? tokens.selectedBg : "transparent",
        border: `1px solid ${active ? tokens.border : "transparent"}`,
        borderRadius: 4,
        padding: "3px 8px",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      <span>{label}</span>
      <span
        className="mono"
        style={{
          fontSize: 10,
          color: active ? (color ?? tokens.textHi) : tokens.textFaint,
        }}
      >
        {count}
      </span>
    </button>
  );
}

/* ----------------------------------------------------------------------------
 * Toggle Switch
 * -------------------------------------------------------------------------- */
function Toggle({
  on,
  onClick,
  color,
}: {
  on: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        width: 38,
        height: 21,
        background: on ? color : tokens.border,
        borderRadius: 11,
        position: "relative",
        cursor: "pointer",
        transition: "background 0.15s",
        flex: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: on ? 19 : 2,
          width: 17,
          height: 17,
          borderRadius: "50%",
          background: tokens.text,
          transition: "left 0.15s",
        }}
      />
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Category Rail Item
 * -------------------------------------------------------------------------- */
function CatItem({
  label,
  count,
  tripCount,
  active,
  onClick,
  color,
  icon,
}: {
  label: string;
  count: number;
  tripCount?: number;
  active: boolean;
  onClick: () => void;
  color?: string;
  icon?: string;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 16px",
        cursor: "pointer",
        borderLeft: `2px solid ${active ? (color ?? tokens.accent) : "transparent"}`,
        background: active ? tokens.selectedBg : "transparent",
        transition: "background 0.15s",
      }}
    >
      {icon && (
        <span
          className="ms"
          style={{
            fontSize: 16,
            color: active ? (color ?? tokens.accent) : tokens.textFaint,
          }}
        >
          {icon}
        </span>
      )}
      <span
        className="mono"
        style={{
          fontSize: 11.5,
          color: active ? tokens.text : tokens.textMuted,
          fontWeight: active ? 600 : 400,
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1 }} />
      <span
        className="mono"
        style={{ fontSize: 10, color: tokens.textFaint }}
        title={`${count} policies${tripCount !== undefined ? `, ${tripCount} trips` : ""}`}
      >
        {count}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Loading Skeleton
 * -------------------------------------------------------------------------- */
function AutonomySkeleton() {
  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div
        style={{
          width: 220,
          flex: "none",
          borderRight: `1px solid ${tokens.borderSoft}`,
          padding: "14px 16px",
        }}
      >
        <div
          style={{
            height: 12,
            width: 110,
            background: tokens.borderSoft,
            borderRadius: 4,
            marginBottom: 16,
          }}
        />
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            style={{
              height: 26,
              background: tokens.borderDivider,
              borderRadius: 4,
              marginBottom: 8,
            }}
          />
        ))}
      </div>

      <div
        style={{
          flex: 1,
          padding: "18px 24px 40px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div
          style={{
            height: 76,
            background: tokens.bgCard,
            border: `1px solid ${tokens.borderSoft}`,
            borderRadius: 12,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                height: 110,
                background: tokens.bgCard,
                border: `1px solid ${tokens.borderSoft}`,
                borderRadius: 8,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Error State
 * -------------------------------------------------------------------------- */
function AutonomyError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: 32,
        textAlign: "center",
      }}
    >
      <span
        className="ms"
        style={{ fontSize: 38, color: tokens.bleed, marginBottom: 12 }}
      >
        error_outline
      </span>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: tokens.textHi,
          marginBottom: 6,
        }}
      >
        Failed to load Autonomy Guardrails
      </div>
      <div
        className="mono"
        style={{
          fontSize: 12,
          color: tokens.textSecondary,
          maxWidth: 480,
          marginBottom: 18,
          lineHeight: 1.5,
        }}
      >
        {error.message || "An unexpected error occurred while communicating with forge-control."}
      </div>
      <button
        onClick={onRetry}
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: tokens.textHi,
          background: tokens.primaryActionBg,
          border: `1px solid ${tokens.accent}`,
          borderRadius: 6,
          padding: "8px 18px",
          cursor: "pointer",
        }}
      >
        Retry Loading
      </button>
    </div>
  );
}

