"use client";

/**
 * UsagePanel — the credit tracker. Quota gauges, token/cost history, EUR rate.
 *
 * Settings is the ONE place in this UI where money numbers are allowed, and
 * this is the panel they belong to. Everywhere else — the composer strip, the
 * status bar, the Live panel — shows percentages and reset times only.
 *
 * ── What the numbers are, and are not ────────────────────────────────────
 * Two different things share this panel and must never be confused:
 *
 *   QUOTA (top)      measured subscription utilisation, straight from
 *                    Anthropic's OAuth usage endpoint. This is the number that
 *                    decides whether the next run gets served.
 *
 *   SHADOW COST      what the tokens the fleet moved WOULD have cost on the
 *                    metered API. Konrad pays a flat subscription; no invoice
 *                    moves when this figure moves. It is a magnitude, not a
 *                    bill, and the panel says so in the header rather than
 *                    leaving a euro sign to imply otherwise.
 *
 * ── Honesty rules this panel inherits ────────────────────────────────────
 *  • A missing bucket is drawn as a GAP. `usageApi.alignSlots` lays the
 *    sampled points onto a continuous grid; slots with no reading get a
 *    baseline tick, not a zero bar and never an interpolated value. An hour
 *    nobody sampled and an hour with no runs are different facts and look
 *    different here.
 *  • The series is only as fresh as the last CLOSED hour, so `sampled_through`
 *    is printed with its age. A chart that implies live numbers when the
 *    sampler last ran at 02:00 is the same class of lie the Live panel spent
 *    three rounds removing.
 *  • `attribution` is printed verbatim from the API, because it explains why a
 *    four-hour run is one token spike with cost spread beneath it. Verbatim
 *    matters: the server stamps the rule that produced each bucket, and the
 *    rule has changed twice (round 1354, round 1355) — a panel that hardcoded
 *    an old wording would now be labelling new numbers with an old promise.
 *  • `run_count` is labelled "turns" everywhere it is shown, not "runs" — it
 *    counts spend_log rows (one per billed turn), so a four-hour chat run
 *    contributes four to it, not one. A number whose label disagrees with its
 *    meaning is the defect class round 1355 was for.
 *  • The KNOWN OVERCOUNT paragraph in `ShadowCostNote` is not decoration: a
 *    run idling >=2h across buckets before resuming is folded into two
 *    buckets' token totals, not one (usage-sampler.ts's KNOWN EXCEPTION note
 *    by LINKED names the exact mechanism). Konrad has caught this panel
 *    overclaiming before; the caveat stays next to the numbers, not in a doc.
 *
 * ── Constraints honoured ─────────────────────────────────────────────────
 *  • Charts are hand-rolled inline SVG. This repo has no chart library and
 *    does not gain one for four bar charts.
 *  • Every colour is a `tokens.*` reference (a `var(--fg-…)`), including chart
 *    fills — SVG gets them through `style`, not through presentation
 *    attributes, because a presentation attribute does not resolve `var()`.
 *    Both themes work; there is no hex or rgb literal in this file.
 *  • Hover is CSS-only (scoped stylesheet + native SVG <title>). No hover
 *    state re-renders this panel — the lag this project is busy deleting.
 *  • The quota query shares `["usage","quota"]`, `refetchInterval: 120_000`
 *    and `staleTime: 60_000` with QuotaBars (DesktopApp.tsx) and QuotaStrip,
 *    so opening settings adds observers, not polls.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../../tokens";
import {
  DAY_MS,
  HOUR_MS,
  WEEK_MS,
  ago,
  alignSlots,
  anchorFor,
  eurOf,
  fetchUsageQuota,
  fetchUsageRate,
  fetchUsageSeries,
  fmtEur,
  fmtExact,
  fmtTokens,
  fmtUsd,
  labelFor,
  putUsageRate,
  stampFor,
  totalTokens,
  type QuotaSnapshot,
  type QuotaWindow,
  type RateSetting,
  type Slot,
  type UsagePoint,
  type UsageSeries,
} from "./usageApi";

/** Which quantity the bars are sized by. Tokens and euros cannot share one
 *  axis — cache reads outweigh output tokens by two orders of magnitude — so
 *  the reader picks, and BOTH totals are printed either way. */
type Metric = "eur" | "tokens";

type Grain = "hour" | "day" | "week";

const PANEL_CSS = `
[data-usage-panel] .usage-bar { transition: opacity 0.1s ease; }
[data-usage-panel] .usage-bar:hover { opacity: 0.62; }
[data-usage-panel] .usage-btn { transition: border-color 0.12s ease, background-color 0.12s ease; }
[data-usage-panel] .usage-btn:hover:not(:disabled) { border-color: ${tokens.borderEmphasis}; background: ${tokens.rowHover}; }
[data-usage-panel] .usage-week-row { transition: background-color 0.12s ease; }
[data-usage-panel] .usage-week-row:hover { background: ${tokens.rowHover}; }
@media (prefers-reduced-motion: reduce) {
  [data-usage-panel] .usage-bar,
  [data-usage-panel] .usage-btn,
  [data-usage-panel] .usage-week-row { transition: none; }
}
`;

export function UsagePanel(): JSX.Element {
  const qc = useQueryClient();
  const [metric, setMetric] = useState<Metric>("eur");

  // Same key/fetch cadence as QuotaBars and QuotaStrip: three observers, one
  // poll. A second interval here would be a regression against the project's
  // poll budget.
  const quota = useQuery<QuotaSnapshot>({
    queryKey: ["usage", "quota"],
    queryFn: () => fetchUsageQuota(false),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  // The series only moves when an hour closes. Polling it faster than that
  // would be asking the same question of the same table sixty times an hour.
  const series = useQuery<UsageSeries>({
    queryKey: ["usage", "series"],
    queryFn: fetchUsageSeries,
    refetchInterval: 300_000,
    staleTime: 120_000,
  });

  const rate = useQuery<RateSetting>({
    queryKey: ["usage", "rate"],
    queryFn: fetchUsageRate,
    staleTime: 300_000,
  });

  // Re-render each minute so "2h ago" on the quota reading and on
  // `sampled_through` stays truthful between polls — QuotaBars' trick, no
  // extra fetch.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  /** The rate every euro on screen is priced at. `/usage/rate` is the
   *  authority; until it answers, the series' own `eur_per_usd` (served from
   *  the same app_settings row) stands in, so the panel never prices anything
   *  at a guessed rate. */
  const eurPerUsd = rate.data?.eur_per_usd ?? series.data?.eur_per_usd ?? null;

  const now = Date.now();
  const hourly = useMemo<Slot[] | null>(
    () =>
      series.data
        ? alignSlots(series.data.hourly, HOUR_MS, anchorFor("hour", now), 24)
        : null,
    // `now` intentionally omitted: re-aligning on every render would shift the
    // axis mid-interaction. The 300s refetch brings a new anchor with new data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series.data],
  );
  const daily = useMemo<Slot[] | null>(
    () =>
      series.data
        ? alignSlots(series.data.daily, DAY_MS, anchorFor("day", now), 30)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series.data],
  );
  const weekly = useMemo<Slot[] | null>(
    () =>
      series.data
        ? alignSlots(series.data.weekly, WEEK_MS, anchorFor("week", now), 12)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series.data],
  );

  const refreshQuota = useCallback(async () => {
    const fresh = await fetchUsageQuota(true);
    qc.setQueryData(["usage", "quota"], fresh);
  }, [qc]);

  return (
    <div data-usage-panel style={{ maxWidth: 940 }}>
      <style>{PANEL_CSS}</style>

      <ShadowCostNote series={series.data ?? null} rate={rate.data ?? null} />

      <QuotaCard
        snapshot={quota.data ?? null}
        error={quota.error}
        onRefresh={refreshQuota}
      />

      <RateCard
        rate={rate.data ?? null}
        error={rate.error}
        onSaved={(next) => {
          // Price the whole panel at the new rate immediately — the euros are
          // derived client-side from shadow_usd, so no refetch is needed for
          // them. The series is invalidated anyway so its server-side `eur`
          // fields (unused here, but part of the cached payload) do not sit
          // stale in the cache for another five minutes.
          qc.setQueryData(["usage", "rate"], next);
          void qc.invalidateQueries({ queryKey: ["usage", "series"] });
        }}
      />

      {series.error instanceof Error && (
        <ErrorCard title="Usage history unavailable" detail={series.error.message} />
      )}

      {series.isLoading && !series.data && (
        <div style={{ ...cardStyle(), textAlign: "center", color: tokens.textFaint }}>
          <span className="mono" style={{ fontSize: 12 }}>
            loading usage history…
          </span>
        </div>
      )}

      {series.data && eurPerUsd !== null && hourly && daily && weekly && (
        <>
          <MetricToggle metric={metric} onChange={setMetric} />

          <ChartCard
            unit="HOURS"
            subtitle="one bar per UTC hour"
            grain="hour"
            slots={hourly}
            metric={metric}
            eurPerUsd={eurPerUsd}
            labelEvery={3}
          />

          <ChartCard
            unit="DAYS"
            subtitle="one bar per UTC day"
            grain="day"
            slots={daily}
            metric={metric}
            eurPerUsd={eurPerUsd}
            labelEvery={5}
          />

          <WeeklyCard slots={weekly} metric={metric} eurPerUsd={eurPerUsd} />
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Header — what these numbers mean, before any of them are shown.
 * ═══════════════════════════════════════════════════════════════════════════ */

function ShadowCostNote({
  series,
  rate,
}: {
  series: UsageSeries | null;
  rate: RateSetting | null;
}): JSX.Element {
  const through = series?.sampled_through ?? null;
  return (
    <div
      style={{
        background: tokens.invariantBg,
        border: `1px solid ${tokens.invariantBorder}`,
        borderRadius: 10,
        padding: "13px 15px",
        marginBottom: 16,
        fontSize: 12.5,
        lineHeight: 1.55,
      }}
    >
      <div
        className="mono"
        style={{ fontSize: 10.5, color: tokens.textLabel, marginBottom: 6 }}
      >
        SHADOW COST — NOT AN INVOICE
      </div>
      <div style={{ color: tokens.textBody }}>
        Every euro below is what these tokens <em>would</em> have cost on the
        metered API. The subscription is flat-rate: none of this is money you
        paid. The quota bars are the number that actually constrains you.
      </div>
      <div style={{ marginTop: 8, color: tokens.warn }}>
        Known overcount: a run that idles 2+ hours and then resumes can be
        folded into two buckets' token totals instead of one — the sampler
        freezes a bucket after two writes and never revisits it. Observed on
        live data: 16 double-foldings across 4 runs in 30 days, worst case one
        run counted 7×. Cost figures are unaffected — they are summed per
        turn, never folded.
      </div>
      <div
        className="mono"
        style={{
          marginTop: 8,
          fontSize: 11,
          color: tokens.textFaint,
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 14px",
        }}
      >
        <span>
          attribution: {series ? series.attribution : "—"}
        </span>
        <span>
          sampled through:{" "}
          {through === null
            ? series
              ? "never — the hourly sampler has not written a bucket yet"
              : "—"
            : `${stampFor(Date.parse(through))} (${ago(through)})`}
        </span>
        {rate && (
          <span>
            rate: {rate.eur_per_usd} €/$ ({rate.source === "default" ? "default" : "set by you"})
          </span>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Quota — the measured subscription windows.
 * ═══════════════════════════════════════════════════════════════════════════ */

function QuotaCard({
  snapshot,
  error,
  onRefresh,
}: {
  snapshot: QuotaSnapshot | null;
  error: unknown;
  onRefresh: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onRefresh();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [onRefresh]);

  const loadError =
    failure ?? (error instanceof Error ? error.message : null);

  return (
    <div style={cardStyle()}>
      <CardHead
        title="SUBSCRIPTION QUOTA"
        note={
          snapshot
            ? `read ${ago(snapshot.fetched_at)}${snapshot.cached ? " · cached" : ""}`
            : "no reading yet"
        }
        right={
          <button
            type="button"
            className="mono usage-btn"
            onClick={() => void refresh()}
            disabled={busy}
            style={btnStyle()}
          >
            {busy ? "refreshing…" : "↻ refresh"}
          </button>
        }
      />

      {snapshot === null && loadError === null && (
        <div className="mono" style={{ fontSize: 12, color: tokens.textFaint }}>
          waiting for the first quota reading…
        </div>
      )}

      {snapshot && (
        <div style={{ display: "grid", gap: 12 }}>
          <QuotaBar label="5-hour window" w={snapshot.five_hour} />
          <QuotaBar label="7-day window" w={snapshot.seven_day} />
          {snapshot.seven_day_opus && (
            <QuotaBar label="7-day Opus" w={snapshot.seven_day_opus} />
          )}
        </div>
      )}

      {snapshot?.error && (
        <div style={{ marginTop: 12, fontSize: 12, color: tokens.warn }}>
          {snapshot.error}
          {typeof snapshot.retry_in_ms === "number" && snapshot.retry_in_ms > 0 && (
            <> · retrying in {Math.ceil(snapshot.retry_in_ms / 1000)}s</>
          )}
        </div>
      )}

      {loadError && (
        <div style={{ marginTop: 12, fontSize: 12, color: tokens.bleed }}>
          {loadError}
        </div>
      )}
    </div>
  );
}

/** Same visual language as `QuotaBars.Bar` in DesktopApp.tsx — same pressure
 *  colouring (ok → warn → bleed), same track, same "—" for a reading we do not
 *  have. Read from there and matched by hand rather than imported: that Bar is
 *  a status-bar-sized closure over its parent's state, and importing it would
 *  couple this panel to the shell's chrome. */
function QuotaBar({ label, w }: { label: string; w: QuotaWindow }): JSX.Element {
  const pct = w.utilization;
  const colour =
    pct === null
      ? tokens.textFaint
      : pct >= 90
        ? tokens.bleed
        : pct >= 70
          ? tokens.warn
          : tokens.ok;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span
        className="mono"
        style={{ fontSize: 11, color: tokens.textLabel, width: 116, flex: "none" }}
      >
        {label}
      </span>
      <span
        style={{
          flex: 1,
          height: 8,
          borderRadius: 4,
          background: tokens.borderEmphasis,
          overflow: "hidden",
          minWidth: 60,
        }}
      >
        {/* A window with no reading gets NO fill — never a 0% bar for a number
            nobody has. */}
        {pct !== null && (
          <span
            style={{
              display: "block",
              width: `${Math.min(100, Math.max(0, pct))}%`,
              height: "100%",
              background: colour,
            }}
          />
        )}
      </span>
      <span
        className="mono"
        style={{ fontSize: 12, color: colour, width: 46, textAlign: "right", flex: "none" }}
      >
        {pct === null ? "—" : `${Math.round(pct)}%`}
      </span>
      <span
        className="mono"
        style={{ fontSize: 11, color: tokens.textFaint, width: 150, flex: "none" }}
      >
        {resetNote(w.resets_at)}
      </span>
    </div>
  );
}

function resetNote(iso: string | null): string {
  if (!iso) return "reset time unknown";
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return "reset time unknown";
  if (ms <= 0) return "resetting now";
  const m = Math.round(ms / 60_000);
  const when = new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return m < 60
    ? `resets in ${m}m · ${when}`
    : `resets in ${Math.round(m / 60)}h · ${when}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * EUR rate — the one editable number on this panel.
 * ═══════════════════════════════════════════════════════════════════════════ */

function RateCard({
  rate,
  error,
  onSaved,
}: {
  rate: RateSetting | null;
  error: unknown;
  onSaved: (next: RateSetting) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (rate ? String(rate.eur_per_usd) : "");

  const save = useMutation({
    mutationFn: (next: number) => putUsageRate(next),
    onSuccess: (next) => {
      setDraft(null);
      onSaved(next);
    },
  });

  const parsed = Number(value);
  const dirty = rate !== null && draft !== null && parsed !== rate.eur_per_usd;
  // The server owns the real bounds (0.1–10, RateValidationError) and its 400
  // message is shown verbatim. This only stops an obviously-unsendable body.
  const sendable = draft !== null && value.trim() !== "" && Number.isFinite(parsed);

  const loadError = error instanceof Error ? error.message : null;
  const saveError = save.error instanceof Error ? save.error.message : null;

  return (
    <div style={cardStyle()}>
      <CardHead
        title="EUR PER USD"
        note={
          rate
            ? rate.source === "default"
              ? "server default — no override stored"
              : `set by you${rate.updated_at ? ` · ${ago(rate.updated_at)}` : ""}`
            : "loading…"
        }
      />

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <input
          className="mono"
          type="number"
          step="0.01"
          min="0.1"
          max="10"
          value={value}
          disabled={rate === null}
          onChange={(e) => setDraft(e.target.value)}
          style={{
            background: tokens.inputBg,
            border: `1px solid ${tokens.border}`,
            borderRadius: 7,
            color: tokens.text,
            fontSize: 13,
            padding: "6px 9px",
            width: 110,
          }}
        />
        <button
          type="button"
          className="mono usage-btn"
          disabled={!sendable || !dirty || save.isPending}
          onClick={() => save.mutate(parsed)}
          style={btnStyle()}
        >
          {save.isPending ? "saving…" : "save rate"}
        </button>
        {rate && rate.source === "app_settings" && (
          <button
            type="button"
            className="mono usage-btn"
            disabled={save.isPending}
            onClick={() => save.mutate(rate.default_eur_per_usd)}
            style={btnStyle()}
          >
            reset to {rate.default_eur_per_usd}
          </button>
        )}
        <span style={{ fontSize: 12, color: tokens.textSoft, flex: 1, minWidth: 220 }}>
          Every euro on this panel is {value || "—"} × the USD the metered API
          would have charged. Changing it re-prices the charts, not history:
          the stored truth is USD.
        </span>
      </div>

      {(loadError ?? saveError) && (
        <div style={{ marginTop: 10, fontSize: 12, color: tokens.bleed }}>
          {saveError ?? loadError}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Charts — hand-rolled SVG. No chart library, by constraint and by size.
 * ═══════════════════════════════════════════════════════════════════════════ */

function MetricToggle({
  metric,
  onChange,
}: {
  metric: Metric;
  onChange: (m: Metric) => void;
}): JSX.Element {
  const opt = (m: Metric, label: string) => (
    <button
      key={m}
      type="button"
      className="mono usage-btn"
      onClick={() => onChange(m)}
      style={{
        ...btnStyle(),
        background: metric === m ? tokens.selectedBg : tokens.toolBg,
        color: metric === m ? tokens.text : tokens.textMuted,
        borderColor: metric === m ? tokens.accent : tokens.border,
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "4px 0 12px",
      }}
    >
      <span className="mono" style={{ fontSize: 10.5, color: tokens.textLabel }}>
        BARS SIZED BY
      </span>
      {opt("eur", "shadow €")}
      {opt("tokens", "tokens")}
      <span style={{ fontSize: 11.5, color: tokens.textFaint }}>
        both totals are printed either way — they cannot share one axis
      </span>
    </div>
  );
}

function metricValue(p: UsagePoint, metric: Metric, eurPerUsd: number): number {
  return metric === "eur" ? eurOf(p.shadow_usd, eurPerUsd) : totalTokens(p);
}

function metricLabel(v: number, metric: Metric): string {
  return metric === "eur" ? fmtEur(v) : fmtTokens(v);
}

interface Totals {
  tokens: number;
  usd: number;
  /** `run_count` counts spend_log rows billed into the bucket, and spend_log
   *  gets one row per TURN (executor.ts:1147 runs once per invocation, and a
   *  chat run is re-entered every turn) — so this is a turn count, not a
   *  run count. Named `turns` here so the label matches the number. */
  turns: number;
  sampled: number;
  gaps: number;
}

function sumSlots(slots: readonly Slot[]): Totals {
  let tokens = 0;
  let usd = 0;
  let turns = 0;
  let sampled = 0;
  for (const s of slots) {
    if (!s.point) continue;
    sampled++;
    tokens += totalTokens(s.point);
    usd += s.point.shadow_usd;
    turns += s.point.run_count;
  }
  return { tokens, usd, turns, sampled, gaps: slots.length - sampled };
}

/** Bar chart over a continuous grid of slots. Missing slots are holes with a
 *  baseline tick; sampled-but-idle slots get a hairline so "we looked and
 *  nothing ran" is visibly not "we never looked". */
function ChartCard({
  unit,
  subtitle,
  grain,
  slots,
  metric,
  eurPerUsd,
  labelEvery,
}: {
  /** Plural grain name for the heading — "HOURS", "DAYS". */
  unit: string;
  subtitle: string;
  grain: Grain;
  slots: readonly Slot[];
  metric: Metric;
  eurPerUsd: number;
  labelEvery: number;
}): JSX.Element {
  // The heading counts the bars actually drawn, not the window the panel asked
  // for. `/usage/series` selects `bucket_start >= now - 30d`, which can return
  // a 31st partial day; `alignSlots` keeps it rather than dropping data, so the
  // title says 31 and stays true instead of labelling 31 bars "last 30 days".
  const title = `LAST ${slots.length} ${unit}`;
  const W = 960;
  const H = 150;
  const t = sumSlots(slots);
  const values = slots.map((s) =>
    s.point ? metricValue(s.point, metric, eurPerUsd) : null,
  );
  const peak = values.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0);
  const slotW = W / slots.length;
  const barW = Math.max(1, slotW - Math.min(3, slotW * 0.22));

  return (
    <div style={cardStyle()}>
      <CardHead
        title={title}
        note={`${subtitle} · ${t.sampled}/${slots.length} sampled${
          t.gaps > 0 ? ` · ${t.gaps} gap${t.gaps === 1 ? "" : "s"} drawn as holes` : ""
        }`}
        right={
          <span className="mono" style={{ fontSize: 11.5, color: tokens.textSoft }}>
            {fmtTokens(t.tokens)} tokens · {fmtEur(eurOf(t.usd, eurPerUsd))} shadow ·{" "}
            {t.turns} turns
          </span>
        }
      />

      <div style={{ position: "relative" }}>
        <svg
          role="img"
          aria-label={`${title}: ${metric === "eur" ? "shadow cost" : "tokens"} per ${grain}`}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height: H, display: "block" }}
        >
          {/* Baseline and a half-peak guide. Both are 1 SVG unit tall; the
              viewBox is stretched horizontally only, so they stay hairlines. */}
          <rect
            x={0}
            y={H - 1}
            width={W}
            height={1}
            style={{ fill: tokens.borderDivider }}
          />
          <rect
            x={0}
            y={H / 2}
            width={W}
            height={1}
            style={{ fill: tokens.borderSoft, opacity: 0.6 }}
          />

          {slots.map((s, i) => {
            const x = i * slotW + (slotW - barW) / 2;
            const v = values[i];
            if (v === null) {
              // GAP. Nobody sampled this bucket: a washed column so the hole
              // is visible at a glance, and a stub on the baseline so it is
              // still legible where the chart is dense. No bar, no
              // interpolation, and a tooltip that says which hour is missing.
              return (
                <g key={s.start} className="usage-bar">
                  <title>{`${stampFor(s.start)} — no sample`}</title>
                  <rect
                    x={x}
                    y={0}
                    width={barW}
                    height={H - 1}
                    style={{ fill: tokens.textGhost, opacity: 0.14 }}
                  />
                  <rect
                    x={x}
                    y={H - 4}
                    width={barW}
                    height={3}
                    style={{ fill: tokens.textGhost, opacity: 0.55 }}
                  />
                </g>
              );
            }
            const h = peak > 0 ? Math.max(1, (v / peak) * (H - 8)) : 1;
            const point = s.point as UsagePoint;
            return (
              <rect
                key={s.start}
                className="usage-bar"
                x={x}
                y={H - h}
                width={barW}
                height={h}
                style={{ fill: v > 0 ? tokens.accent : tokens.textFaint }}
              >
                <title>{tooltip(point, s.start, eurPerUsd)}</title>
              </rect>
            );
          })}
        </svg>

        <span
          className="mono"
          style={{
            position: "absolute",
            top: 0,
            right: 2,
            fontSize: 10,
            color: tokens.textGhost,
            pointerEvents: "none",
          }}
        >
          peak {metricLabel(peak, metric)}
        </span>
      </div>

      <div
        className="mono"
        style={{
          display: "flex",
          marginTop: 5,
          fontSize: 9.5,
          color: tokens.textGhost,
        }}
      >
        {slots.map((s, i) => (
          <span
            key={s.start}
            style={{
              flex: `0 0 ${100 / slots.length}%`,
              textAlign: "center",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {i % labelEvery === 0 ? labelFor(grain, s.start) : ""}
          </span>
        ))}
      </div>
      <div
        className="mono"
        style={{ marginTop: 4, fontSize: 9.5, color: tokens.textGhost }}
      >
        buckets are UTC
      </div>
    </div>
  );
}

function tooltip(p: UsagePoint, start: number, eurPerUsd: number): string {
  return [
    stampFor(start),
    `in ${fmtExact(p.tokens_in)} · out ${fmtExact(p.tokens_out)}`,
    `cache read ${fmtExact(p.cache_read)} · write ${fmtExact(p.cache_write)}`,
    `${fmtExact(totalTokens(p))} tokens total · ${p.run_count} turns`,
    `shadow ${fmtUsd(p.shadow_usd)} = ${fmtEur(eurOf(p.shadow_usd, eurPerUsd))}`,
  ].join("\n");
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Weekly totals — a table, because twelve numbers read better than twelve bars.
 * ═══════════════════════════════════════════════════════════════════════════ */

function WeeklyCard({
  slots,
  metric,
  eurPerUsd,
}: {
  slots: readonly Slot[];
  metric: Metric;
  eurPerUsd: number;
}): JSX.Element {
  const t = sumSlots(slots);
  const peak = slots.reduce<number>(
    (m, s) => (s.point ? Math.max(m, metricValue(s.point, metric, eurPerUsd)) : m),
    0,
  );
  // Newest week first: the one being lived in is the one being asked about.
  const rows = [...slots].reverse();

  return (
    <div style={cardStyle()}>
      <CardHead
        title="WEEKLY TOTALS"
        note={`ISO weeks, Monday-start UTC · ${t.sampled}/${slots.length} sampled`}
        right={
          <span className="mono" style={{ fontSize: 11.5, color: tokens.textSoft }}>
            {fmtTokens(t.tokens)} tokens · {fmtEur(eurOf(t.usd, eurPerUsd))} shadow ·{" "}
            {t.turns} turns
          </span>
        }
      />

      <div style={{ display: "grid", gap: 2 }}>
        {rows.map((s) => {
          const v = s.point ? metricValue(s.point, metric, eurPerUsd) : null;
          const width = v !== null && peak > 0 ? (v / peak) * 100 : 0;
          return (
            <div
              key={s.start}
              className="usage-week-row"
              title={
                s.point
                  ? tooltip(s.point, s.start, eurPerUsd)
                  : `${stampFor(s.start)} — no sample`
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "5px 6px",
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              <span
                className="mono"
                style={{ width: 78, flex: "none", color: tokens.textLabel, fontSize: 11 }}
              >
                {labelFor("week", s.start)}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 60,
                  height: 7,
                  borderRadius: 3,
                  background: tokens.bgGutter,
                  overflow: "hidden",
                }}
              >
                {/* No sample → no fill at all, and the row says so on the
                    right. An empty track is not a zero week. */}
                {v !== null && (
                  <span
                    style={{
                      display: "block",
                      width: `${width}%`,
                      height: "100%",
                      background: v > 0 ? tokens.accent : tokens.textFaint,
                    }}
                  />
                )}
              </span>
              {s.point === null ? (
                <span
                  className="mono"
                  style={{ flex: "none", width: 250, textAlign: "right", color: tokens.textGhost }}
                >
                  no sample
                </span>
              ) : (
                <span
                  className="mono"
                  style={{
                    flex: "none",
                    width: 250,
                    textAlign: "right",
                    color: tokens.textBody,
                  }}
                >
                  {fmtTokens(totalTokens(s.point))} tok ·{" "}
                  {fmtEur(eurOf(s.point.shadow_usd, eurPerUsd))} · {s.point.run_count} turns
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Shared chrome
 * ═══════════════════════════════════════════════════════════════════════════ */

function CardHead({
  title,
  note,
  right,
}: {
  title: string;
  note: string;
  right?: JSX.Element;
}): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        flexWrap: "wrap",
        marginBottom: 12,
      }}
    >
      <span
        className="mono"
        style={{ fontSize: 10.5, letterSpacing: "0.05em", color: tokens.textLabel }}
      >
        {title}
      </span>
      <span className="mono" style={{ fontSize: 10.5, color: tokens.textGhost }}>
        {note}
      </span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}

function ErrorCard({ title, detail }: { title: string; detail: string }): JSX.Element {
  return (
    <div
      style={{
        background: tokens.dangerActionBg,
        border: `1px solid ${tokens.dangerActionBorder}`,
        borderRadius: 10,
        padding: "12px 14px",
        marginBottom: 16,
        fontSize: 13,
      }}
    >
      <strong>{title}</strong>
      <div className="mono" style={{ color: tokens.textSoft, marginTop: 5, fontSize: 12 }}>
        {detail}
      </div>
    </div>
  );
}

function cardStyle(): CSSProperties {
  return {
    background: tokens.bgCard,
    border: `1px solid ${tokens.border}`,
    borderRadius: 12,
    padding: "14px 16px 16px",
    marginBottom: 14,
  };
}

function btnStyle(): CSSProperties {
  return {
    background: tokens.toolBg,
    border: `1px solid ${tokens.border}`,
    borderRadius: 7,
    color: tokens.text,
    cursor: "pointer",
    fontSize: 11.5,
    padding: "5px 10px",
  };
}
