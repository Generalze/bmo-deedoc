"use client";

import type { ReactNode } from "react";

/**
 * Dispatch console primitives.
 *
 * These absorb patterns the audit found hand-written across pages: 206 "panel
 * card" divs, 70 stat figures, 90 uses of a list class that was semantically
 * wrong on 19 of the 20 pages using it, and 143 inline style objects carrying
 * only five distinct spacing values.
 */

/* ---- Surfaces ---------------------------------------------------------- */

export function Panel({
  title,
  meta,
  actions,
  flush,
  children,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Drop body padding so a table can meet the panel edge. */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="panel-console">
      {title ? (
        <header className="panel-head">
          <h2>{title}</h2>
          {meta ? <span className="panel-head-meta">{meta}</span> : null}
          {actions ? <span className={meta ? "cluster" : "panel-head-meta"}>{actions}</span> : null}
        </header>
      ) : null}
      <div className={flush ? "panel-body panel-body-flush" : "panel-body"}>{children}</div>
    </section>
  );
}

export function PageHead({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lead ? <p>{lead}</p> : null}
      </div>
      {actions ? <div className="cluster" style={{ marginLeft: "auto" }}>{actions}</div> : null}
    </header>
  );
}

/* ---- Figures ----------------------------------------------------------- */

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="stat-row">{children}</div>;
}

export function Stat({
  label,
  value,
  note,
  warn,
}: {
  label: string;
  value: ReactNode;
  /** Provenance or a caveat. Use it — an unexplained number invites a wrong reading. */
  note?: ReactNode;
  warn?: boolean;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note ? <span className={warn ? "stat-note stat-note-warn" : "stat-note"}>{note}</span> : null}
    </div>
  );
}

const NAIRA = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat("en-NG");

export function formatMoney(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(numeric) ? NAIRA.format(numeric) : "—";
}

export function formatCount(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? COUNT.format(value) : "—";
}

/**
 * A monetary figure with its provenance.
 *
 * Money in this platform is not all equal: a figure can be authoritative, or
 * re-valued at payment, or legacy value awaiting an approved conversion. The
 * audit found the same naira glyph used for all three. Provenance travels with
 * the number so a reader cannot mistake preserved value for spendable value.
 */
export function Money({
  amount,
  provenance,
}: {
  amount: number | string | null | undefined;
  provenance?: "authoritative" | "revalued" | "legacy-unreconciled";
}) {
  return (
    <span className="money">
      {formatMoney(amount)}
      {provenance === "legacy-unreconciled" ? <span className="pill pill-legacy" style={{ marginLeft: "var(--sp-2)" }}>Not payable</span> : null}
      {provenance === "revalued" ? <span className="pill pill-executed" style={{ marginLeft: "var(--sp-2)" }}>Server-valued</span> : null}
    </span>
  );
}

/* ---- Status ------------------------------------------------------------ */

type PillTone = "pending" | "executed" | "refused" | "legacy" | "stale" | "error";

const STATUS_TONE: Record<string, PillTone> = {
  PENDING: "pending",
  ELIGIBLE: "pending",
  APPROVED: "pending",
  PROCESSING: "pending",
  DRAFT: "stale",
  PAID: "executed",
  CONFIRMED: "executed",
  LEGACY_CARRYOVER_CONFIRMED: "executed",
  HELD: "refused",
  REJECTED: "error",
  FAILED: "error",
  RETIRED: "stale",
  LEGACY_CARRYOVER_PENDING: "legacy",
  LEGACY_CARRYOVER_VOID: "stale",
};

export function StatusPill({ status, tone }: { status: string; tone?: PillTone }) {
  const resolved = tone || STATUS_TONE[status] || "stale";
  return <span className={`pill pill-${resolved}`}>{status.replace(/_/g, " ").toLowerCase()}</span>;
}

/* ---- Tables ------------------------------------------------------------ */

export function DataTable({ caption, head, children }: { caption?: ReactNode; head: ReactNode; children: ReactNode }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>{head}</thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* ---- State ------------------------------------------------------------- */

/**
 * The single loading / empty / error / refused surface.
 *
 * "Refused" is a distinct state from "error" on purpose. The platform declines
 * things deliberately — payouts are disabled, no reconciliation policy is
 * approved — and an operator who cannot tell a deliberate refusal from a broken
 * request will escalate the wrong one.
 */
export function StateView({
  kind,
  title,
  detail,
  action,
}: {
  kind: "loading" | "empty" | "error" | "refused";
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  if (kind === "loading") {
    return (
      <div className="state-view" aria-busy="true" aria-live="polite">
        <div className="skeleton" style={{ width: "12rem" }} />
        <div className="skeleton" style={{ width: "20rem" }} />
        <div className="skeleton" style={{ width: "16rem" }} />
        <span className="muted-text">{title}</span>
      </div>
    );
  }
  if (kind === "empty") {
    return (
      <div className="state-view">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
        {action}
      </div>
    );
  }
  return (
    <div className={kind === "refused" ? "notice notice-refused" : "notice notice-error"} role="status">
      <div className="notice-body">
        <span className="notice-title">{title}</span>
        {detail ? <span>{detail}</span> : null}
        {action}
      </div>
    </div>
  );
}

export function Notice({
  tone = "error",
  title,
  children,
}: {
  tone?: "error" | "refused" | "legacy" | "ok";
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role="status">
      <div className="notice-body">
        <span className="notice-title">{title}</span>
        {children}
      </div>
    </div>
  );
}

/* ---- Fields ------------------------------------------------------------ */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field-console">
      <span>{label}</span>
      {children}
      {hint && !error ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}
