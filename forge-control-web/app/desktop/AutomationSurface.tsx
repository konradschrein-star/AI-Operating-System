"use client";

/**
 * v1.6 Tier-2 phase 4 — Automation surface (Webhooks + Cron).
 *
 * Lifted in concept from NousResearch/hermes-agent WebhooksPage + CronPage +
 * ScheduleBuilder, but rebuilt in V2 inline styles against the local
 * /api/webhooks + /api/cron routes. Two side-by-side panels (list + form)
 * with a tab toggle at the top — same shape as the SkillsSurface rail.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tokens } from "../tokens";
import {
  fetchWebhooks,
  createWebhook,
  updateWebhook,
  rotateWebhookSecret,
  deleteWebhook,
  fetchSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  previewCron,
  type Webhook,
  type CronSchedule,
} from "../api";

type Tab = "webhooks" | "cron";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

const CARD_BORDER = `1px solid ${tokens.border}`;
const CARD_STYLE: React.CSSProperties = {
  background: tokens.bgCard,
  border: CARD_BORDER,
  borderRadius: 8,
  padding: 16,
};

export function AutomationSurface() {
  const [tab, setTab] = useState<Tab>("webhooks");
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "12px 16px",
          borderBottom: `1px solid ${tokens.borderSoft}`,
          alignItems: "center",
        }}
      >
        <TabBtn label="WEBHOOKS" active={tab === "webhooks"} onClick={() => setTab("webhooks")} />
        <TabBtn label="CRON" active={tab === "cron"} onClick={() => setTab("cron")} />
        <div
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: tokens.textMuted,
            letterSpacing: "0.08em",
          }}
          className="mono"
        >
          v1.6 · TIER-2 · PHASE 4
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
        {tab === "webhooks" ? <WebhooksPanel /> : <CronPanel />}
      </div>
    </div>
  );
}

function TabBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="mono"
      style={{
        background: active ? tokens.primaryActionBg : "transparent",
        border: `1px solid ${active ? tokens.accent : tokens.borderSoft}`,
        color: active ? tokens.textHi : tokens.textBody,
        padding: "6px 14px",
        borderRadius: 6,
        fontSize: 11,
        letterSpacing: "0.08em",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

/* ============================================================================
 * Webhooks
 * ========================================================================== */
function WebhooksPanel() {
  const qc = useQueryClient();
  const listQ = useQuery({ queryKey: ["webhooks"], queryFn: fetchWebhooks });

  const [showCreate, setShowCreate] = useState(false);

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 380px" }}>
      <div>
        <SectionHeader
          title="WEBHOOKS"
          subtitle="External services POST to /webhooks/in/<slug> with HMAC sig → spawns a run"
          right={
            <button style={createBtn} onClick={() => setShowCreate((v) => !v)}>
              + new webhook
            </button>
          }
        />
        {showCreate && <WebhookCreateForm onDone={() => setShowCreate(false)} />}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {(listQ.data ?? []).map((w) => (
            <WebhookRow
              key={w.id}
              w={w}
              onChange={() => qc.invalidateQueries({ queryKey: ["webhooks"] })}
            />
          ))}
          {listQ.data && listQ.data.length === 0 && (
            <EmptyHint text="No webhooks yet. The receiver is live at /webhooks/in/<slug> — create one to start dispatching runs from external services." />
          )}
          {listQ.isLoading && <EmptyHint text="Loading…" />}
          {listQ.error && (
            <EmptyHint text={`Error: ${(listQ.error as Error).message}`} />
          )}
        </div>
      </div>
      <SidePanel
        title="HOW IT WORKS"
        lines={[
          "1. Create a webhook with a unique slug + a prompt template.",
          "2. Sign your payload with HMAC-SHA256 of the body using the webhook secret.",
          "3. POST it to /webhooks/in/<slug> with header `X-Forge-Signature: sha256=<hex>` (GitHub-style works too).",
          "4. The receiver renders the template ({{ body.field }} placeholders) and spawns a queued run.",
          "5. The full secret is shown once on create + rotate. It is never returned by GET.",
        ]}
      />
    </div>
  );
}

const createBtn: React.CSSProperties = {
  background: tokens.primaryActionBg,
  border: `1px solid ${tokens.accent}`,
  color: tokens.textHi,
  padding: "6px 14px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
};

function WebhookCreateForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [promptTemplate, setPromptTemplate] = useState(
    "Inbound webhook fired:\n{{ body }}",
  );
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      createWebhook({
        slug: slug.trim().toLowerCase(),
        name: name.trim(),
        prompt_template: promptTemplate,
      }),
    onSuccess: async (w) => {
      // The secret comes back once on create; we have to fetch the full
      // payload separately. Simpler: rotate immediately to surface it.
      const fresh = await rotateWebhookSecret(w.id);
      setSecret(fresh);
      await qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div style={{ ...CARD_STYLE, display: "flex", flexDirection: "column", gap: 12 }}>
      <h4 style={{ ...h4, margin: 0 }}>NEW WEBHOOK</h4>
      <Field label="Slug (url segment)" hint="lowercase, digits, dashes; 3–64 chars">
        <input
          style={inputStyle}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="github-push"
        />
        {slug && !SLUG_RE.test(slug.trim().toLowerCase()) && (
          <div style={errText}>Invalid slug format.</div>
        )}
      </Field>
      <Field label="Display name">
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="GitHub push"
        />
      </Field>
      <Field label="Prompt template" hint="{{ body.field }} placeholders are substituted from the inbound JSON.">
        <textarea
          style={{ ...inputStyle, minHeight: 80, fontFamily: "var(--font-mono)" }}
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
        />
      </Field>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          disabled={
            mut.isPending ||
            !SLUG_RE.test(slug.trim().toLowerCase()) ||
            !name.trim()
          }
          style={primaryBtn(mut.isPending)}
          onClick={() => {
            setErr(null);
            mut.mutate();
          }}
        >
          {mut.isPending ? "creating…" : "create"}
        </button>
        <button style={secondaryBtn} onClick={onDone}>
          done
        </button>
      </div>
      {err && <div style={errText}>{err}</div>}
      {secret && (
        <div style={{ ...CARD_STYLE, background: tokens.okActionBg, borderColor: tokens.okActionBorder }}>
          <div style={{ fontSize: 11, color: tokens.textLabel, marginBottom: 6 }}>
            SECRET — shown once, copy it now:
          </div>
          <code style={{ fontSize: 11, color: tokens.textHi, wordBreak: "break-all" }}>
            {secret}
          </code>
        </div>
      )}
    </div>
  );
}

function WebhookRow({ w, onChange }: { w: Webhook; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    try {
      await updateWebhook(w.id, { enabled: !w.enabled });
      onChange();
    } finally {
      setBusy(false);
    }
  };
  const rotate = async () => {
    setBusy(true);
    try {
      const fresh = await rotateWebhookSecret(w.id);
      setRevealed(fresh);
      onChange();
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete webhook "${w.name}"? External services hitting /webhooks/in/${w.slug} will start getting 404.`)) return;
    setBusy(true);
    try {
      await deleteWebhook(w.id);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={CARD_STYLE}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontSize: 14, color: tokens.textHi, fontWeight: 600 }}>{w.name}</div>
        <code style={{ fontSize: 11, color: tokens.textMuted }}>
          /webhooks/in/{w.slug}
        </code>
        <div
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: w.enabled ? tokens.ok : tokens.textGhost,
            letterSpacing: "0.08em",
          }}
          className="mono"
        >
          {w.enabled ? "● ENABLED" : "○ DISABLED"}
        </div>
      </div>
      <div style={{ fontSize: 12, color: tokens.textMuted, marginTop: 4 }}>
        {w.description ?? "—"}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 11, color: tokens.textMuted2 }}>
        <span>{w.total_calls} calls</span>
        <span>·</span>
        <span>last: {w.last_called_at ?? "never"}</span>
        <span>·</span>
        <span>secret: {w.secret_preview}</span>
      </div>
      {w.last_error && (
        <div style={{ marginTop: 8, fontSize: 11, color: tokens.bleed }}>
          last error: {w.last_error}
        </div>
      )}
      {revealed && (
        <div style={{ marginTop: 8, padding: 8, border: `1px solid ${tokens.okActionBorder}`, background: tokens.okActionBg, borderRadius: 6 }}>
          <div style={{ fontSize: 11, color: tokens.textLabel, marginBottom: 6 }}>
            ROTATED SECRET — copy now:
          </div>
          <code style={{ fontSize: 11, color: tokens.textHi, wordBreak: "break-all" }}>
            {revealed}
          </code>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button style={secondaryBtn} disabled={busy} onClick={toggle}>
          {w.enabled ? "disable" : "enable"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={rotate}>
          rotate secret
        </button>
        <button style={{ ...secondaryBtn, color: tokens.bleed }} disabled={busy} onClick={remove}>
          delete
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
 * Cron
 * ========================================================================== */
function CronPanel() {
  const qc = useQueryClient();
  const listQ = useQuery({ queryKey: ["cron"], queryFn: fetchSchedules });
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr 380px" }}>
      <div>
        <SectionHeader
          title="CRON SCHEDULES"
          subtitle="5-field cron expressions trigger a new run on each match. Ticked in-process every 15s."
          right={
            <button style={createBtn} onClick={() => setShowCreate((v) => !v)}>
              + new schedule
            </button>
          }
        />
        {showCreate && <CronCreateForm onDone={() => setShowCreate(false)} />}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {(listQ.data ?? []).map((s) => (
            <CronRow
              key={s.id}
              s={s}
              onChange={() => qc.invalidateQueries({ queryKey: ["cron"] })}
            />
          ))}
          {listQ.data && listQ.data.length === 0 && (
            <EmptyHint text="No schedules yet. Create one to fire runs on a cron expression." />
          )}
          {listQ.isLoading && <EmptyHint text="Loading…" />}
          {listQ.error && (
            <EmptyHint text={`Error: ${(listQ.error as Error).message}`} />
          )}
        </div>
      </div>
      <SidePanel
        title="CRON CHEAT SHEET"
        lines={[
          "Format:  minute hour day-of-month month day-of-week",
          "",
          "*/15 * * * *     every 15 minutes",
          "0 9 * * 1-5      weekdays at 09:00",
          "30 21 * * *      daily at 21:30",
          "0 0 1 * *        first of every month at midnight",
          "0 12 * * 0       Sundays at noon",
          "",
          "Day-of-week: 0=Sun, 6=Sat.",
          "Combinations: list (1,3,5), range (1-5), step (X/N).",
        ]}
        mono
      />
    </div>
  );
}

function CronCreateForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [cronExpr, setCronExpr] = useState("0 9 * * 1-5");
  const [promptTemplate, setPromptTemplate] = useState("Daily standup brief.");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const previewMut = useMutation({
    mutationFn: () => previewCron(cronExpr, 5),
    onSuccess: (fires) => {
      setPreview(fires);
      setPreviewErr(null);
    },
    onError: (e: Error) => {
      setPreview(null);
      setPreviewErr(e.message);
    },
  });

  const mut = useMutation({
    mutationFn: () =>
      createSchedule({
        name: name.trim(),
        cron_expr: cronExpr.trim(),
        prompt_template: promptTemplate,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["cron"] });
      onDone();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div style={{ ...CARD_STYLE, display: "flex", flexDirection: "column", gap: 12 }}>
      <h4 style={{ ...h4, margin: 0 }}>NEW SCHEDULE</h4>
      <Field label="Name">
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily standup"
        />
      </Field>
      <Field label="Cron expression" hint="5 space-separated fields">
        <input
          style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button style={secondaryBtn} onClick={() => previewMut.mutate()}>
            preview next 5
          </button>
          {previewErr && <div style={errText}>{previewErr}</div>}
        </div>
        {preview && (
          <ul style={{ marginTop: 8, paddingLeft: 16, fontSize: 11, color: tokens.textMuted }}>
            {preview.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </Field>
      <Field label="Prompt template">
        <textarea
          style={{ ...inputStyle, minHeight: 80, fontFamily: "var(--font-mono)" }}
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
        />
      </Field>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          disabled={mut.isPending || !name.trim() || !cronExpr.trim()}
          style={primaryBtn(mut.isPending)}
          onClick={() => {
            setErr(null);
            mut.mutate();
          }}
        >
          {mut.isPending ? "creating…" : "create"}
        </button>
        <button style={secondaryBtn} onClick={onDone}>
          cancel
        </button>
      </div>
      {err && <div style={errText}>{err}</div>}
    </div>
  );
}

function CronRow({ s, onChange }: { s: CronSchedule; onChange: () => void }) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      await updateSchedule(s.id, { enabled: !s.enabled });
      onChange();
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete schedule "${s.name}"?`)) return;
    setBusy(true);
    try {
      await deleteSchedule(s.id);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={CARD_STYLE}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontSize: 14, color: tokens.textHi, fontWeight: 600 }}>{s.name}</div>
        <code style={{ fontSize: 11, color: tokens.textMuted }}>{s.cron_expr}</code>
        <div
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: s.enabled ? tokens.ok : tokens.textGhost,
            letterSpacing: "0.08em",
          }}
          className="mono"
        >
          {s.enabled ? "● ENABLED" : "○ DISABLED"}
        </div>
      </div>
      <div style={{ fontSize: 12, color: tokens.textMuted, marginTop: 4 }}>
        next: {s.next_run_at} · fires: {s.total_fires} · last: {s.last_run_at ?? "never"}
      </div>
      {s.last_error && (
        <div style={{ marginTop: 6, fontSize: 11, color: tokens.bleed }}>
          last error: {s.last_error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button style={secondaryBtn} disabled={busy} onClick={toggle}>
          {s.enabled ? "disable" : "enable"}
        </button>
        <button style={{ ...secondaryBtn, color: tokens.bleed }} disabled={busy} onClick={remove}>
          delete
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
 * Shared bits
 * ========================================================================== */
function SectionHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle: string;
  right?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
      <div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: tokens.textFaint,
            letterSpacing: "0.1em",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 13, color: tokens.textBody, marginTop: 2 }}>
          {subtitle}
        </div>
      </div>
      {right && <div style={{ marginLeft: "auto" }}>{right}</div>}
    </div>
  );
}

function SidePanel({
  title,
  lines,
  mono,
}: {
  title: string;
  lines: string[];
  mono?: boolean;
}) {
  return (
    <div style={{ ...CARD_STYLE, height: "fit-content", position: "sticky", top: 0 }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: tokens.textFaint,
          letterSpacing: "0.1em",
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {lines.map((l, i) => (
        <div
          key={i}
          className={mono ? "mono" : undefined}
          style={{
            fontSize: mono ? 11 : 12,
            color: tokens.textMuted,
            marginBottom: 4,
            whiteSpace: "pre-wrap",
          }}
        >
          {l || " "}
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: tokens.textFaint,
          letterSpacing: "0.1em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div style={{ fontSize: 11, color: tokens.textMuted2, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 12, color: tokens.textMuted, padding: "12px 0" }}>
      {text}
    </div>
  );
}

const h4: React.CSSProperties = {
  fontSize: 13,
  color: tokens.textHi,
  letterSpacing: "0.05em",
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: tokens.bgGutter,
  border: `1px solid ${tokens.border}`,
  color: tokens.textHi,
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 6,
  outline: "none",
};

const primaryBtn = (busy: boolean): React.CSSProperties => ({
  background: busy ? tokens.borderSoft : tokens.primaryActionBg,
  border: `1px solid ${tokens.accent}`,
  color: tokens.textHi,
  padding: "8px 16px",
  borderRadius: 6,
  fontSize: 12,
  cursor: busy ? "wait" : "pointer",
});

const secondaryBtn: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${tokens.borderSoft}`,
  color: tokens.textBody,
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 11,
  cursor: "pointer",
};

const errText: React.CSSProperties = {
  fontSize: 11,
  color: tokens.bleed,
  marginTop: 4,
};
