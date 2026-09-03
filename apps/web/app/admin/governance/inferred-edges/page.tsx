"use client";

import { useEffect, useState } from "react";
import type { AuthUserProfile, InferredEdgeReviewItem, InferredEdgeReviewSummary } from "@pics-nigeria/shared";
import {
  ApiError,
  decideInferredEdge,
  fetchCurrentUser,
  fetchInferredEdges,
} from "../../../../lib/api";
import { AdminNav } from "../../../../components/admin-nav";
import { ConfirmDialog } from "../../../../components/confirm-dialog";
import { FeedbackBanner } from "../../../../components/feedback-banner";
import { clearSession, readSession } from "../../../../lib/session";

/**
 * Inferred-edge governance.
 *
 * One ward at a time, deliberately. The release resolved 55 of Ogun's 236 ward
 * edges by inference, and member ancestry refuses to build on one until a person
 * confirms it. This screen is where that confirmation happens — and it is the
 * whole of the workflow, not a territory editor. Nothing here can change which
 * constituency a ward belongs to; that is reference data.
 */

type Filter = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "PENDING", label: "Awaiting review" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
  { key: "ALL", label: "All" },
];

export default function InferredEdgeGovernancePage() {
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<AuthUserProfile | null>(null);
  const [edges, setEdges] = useState<InferredEdgeReviewItem[]>([]);
  const [summary, setSummary] = useState<InferredEdgeReviewSummary | null>(null);
  const [filter, setFilter] = useState<Filter>("PENDING");
  const [selected, setSelected] = useState<InferredEdgeReviewItem | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = readSession();
    if (!stored) {
      window.location.href = "/login";
      return;
    }
    setToken(stored);
    fetchCurrentUser(stored)
      .then(setProfile)
      .catch(() => {
        clearSession();
        window.location.href = "/login";
      });
  }, []);

  async function load(active: string, wanted: Filter) {
    setLoading(true);
    try {
      const result = await fetchInferredEdges(active, wanted);
      setEdges(result.edges);
      setSummary(result.summary);
      setError("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not load inferred edges.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) {
      void load(token, filter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, filter]);

  async function decide(outcome: "approve" | "reject") {
    if (!token || !selected?.stateConstituency) return;
    try {
      const result = await decideInferredEdge(token, selected.wardId, outcome, {
        stateConstituencyId: selected.stateConstituency.id,
        reason: reason.trim(),
      });
      setMessage(result.message);
      setError("");
      setSelected(null);
      setReason("");
      await load(token, filter);
    } catch (cause) {
      // A 409 means the ward moved under the reviewer; the reason is worth
      // showing verbatim, because the correct response is to reload and look
      // again rather than to retry.
      setError(cause instanceof ApiError ? cause.message : "Could not record the decision.");
      setMessage("");
      if (token) await load(token, filter);
    } finally {
      setPending(null);
    }
  }

  if (profile && profile.role !== "SUPER_ADMIN") {
    return (
      <main className="page">
        <AdminNav />
        <section className="panel">
          <h1>Inferred edge governance</h1>
          <p className="muted">This review is restricted to the Super Admin.</p>
        </section>
      </main>
    );
  }

  const reasonTooShort = reason.trim().length < 10;

  return (
    <main className="page">
      <AdminNav />

      <section className="panel">
        <h1>Inferred constituency edges</h1>
        <p className="muted">
          These wards were matched to a State Constituency by inference rather than read from an authoritative
          source. Until a reviewer confirms one, members on that ward cannot be given constituency ancestry and
          are not counted at State Constituency, Federal Constituency or Senatorial District level.
        </p>
        <p className="muted">
          Approving records that you checked this exact mapping. Rejecting records that it is wrong and leaves
          the ward blocked — correcting it is a reference-data change, not something this screen can do.
        </p>

        {summary ? (
          <dl className="stat-row">
            <div>
              <dt>Awaiting review</dt>
              <dd>{summary.pending}</dd>
            </div>
            <div>
              <dt>Approved</dt>
              <dd>{summary.approved}</dd>
            </div>
            <div>
              <dt>Rejected</dt>
              <dd>{summary.rejected}</dd>
            </div>
            <div>
              <dt>Inferred edges</dt>
              <dd>{summary.total}</dd>
            </div>
          </dl>
        ) : null}

        {error ? <FeedbackBanner tone="error" message={error} /> : null}
        {message ? <FeedbackBanner tone="success" message={message} /> : null}

        <nav className="tab-row">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={filter === item.key ? "button" : "button secondary"}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </section>

      <section className="panel">
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && edges.length === 0 ? <p className="muted">No edges in this state.</p> : null}

        <ul className="record-list">
          {edges.map((edge) => (
            <li key={edge.wardId} className="record-list__item">
              <div>
                <strong>{edge.wardName}</strong>
                <p className="muted">
                  {edge.lga?.name ?? "Unknown LGA"} → {edge.stateConstituency?.name ?? "No constituency"}
                  {edge.stateConstituency?.federalConstituency
                    ? ` → ${edge.stateConstituency.federalConstituency.name}`
                    : ""}
                  {edge.stateConstituency?.federalConstituency?.senatorialDistrict
                    ? ` → ${edge.stateConstituency.federalConstituency.senatorialDistrict.name}`
                    : ""}
                </p>
                <p className="muted">Basis: {edge.inferenceBasis ?? "not recorded"}</p>
                <p className="muted">
                  {edge.impact.members} member(s), {edge.impact.coordinators} coordinator(s) affected ·{" "}
                  {edge.operational ? "operational" : "blocked"} · {edge.reviewState.toLowerCase()}
                </p>
                {edge.decision ? (
                  <p className="muted">
                    {edge.decision.outcome === "APPROVED" ? "Approved" : "Rejected"} by{" "}
                    {edge.decision.reviewer?.name ?? "unknown"} — “{edge.decision.reason}”
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setSelected(edge);
                  setReason("");
                }}
              >
                Review
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selected ? (
        <section className="panel">
          <h2>{selected.wardName}</h2>
          <p className="muted">
            Deciding: <strong>{selected.wardName}</strong> belongs to{" "}
            <strong>{selected.stateConstituency?.name ?? "no constituency"}</strong>.
          </p>

          <h3>Source evidence</h3>
          <ul>
            <li>
              INEC delimitation:{" "}
              {selected.sourceEvidence.inecDelimitation
                ? `${selected.sourceEvidence.inecDelimitation.name} (${selected.sourceEvidence.inecDelimitation.code})`
                : "no record"}
            </li>
            <li>
              Constituency workbook spelling:{" "}
              {selected.sourceEvidence.constituencyWorkbook
                ? selected.sourceEvidence.constituencyWorkbook.aliases.join(", ")
                : "no differing spelling recorded"}
            </li>
            <li>
              Constituency source code:{" "}
              {selected.sourceEvidence.constituencySourceCode
                ? `${selected.sourceEvidence.constituencySourceCode.code}`
                : "no record"}
            </li>
          </ul>
          <p className="muted">{selected.sourceEvidence.note}</p>
          <p className="muted">Inference basis: {selected.inferenceBasis ?? "not recorded"}</p>
          <p className="muted">
            Impact today: {selected.impact.members} member(s), {selected.impact.coordinators} coordinator(s).
            Coordinators are shown for context only; this decision does not change them.
          </p>

          <label className="starter-form__field">
            <span>Reason (recorded permanently, minimum 10 characters)</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="What did you check, and what did you conclude?"
            />
          </label>

          <div className="button-row">
            <button
              type="button"
              className="button"
              disabled={reasonTooShort}
              onClick={() => setPending("approve")}
            >
              Approve this edge
            </button>
            <button
              type="button"
              className="button danger"
              disabled={reasonTooShort}
              onClick={() => setPending("reject")}
            >
              Reject this edge
            </button>
            <button type="button" className="button secondary" onClick={() => setSelected(null)}>
              Cancel
            </button>
          </div>
          {reasonTooShort ? <p className="muted">A reason is required before either decision.</p> : null}
        </section>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        title={pending === "approve" ? "Approve this constituency edge?" : "Reject this constituency edge?"}
        description={
          pending === "approve"
            ? `${selected?.wardName} will be treated as belonging to ${selected?.stateConstituency?.name}. Members on this ward will be given that constituency ancestry and counted there.`
            : `${selected?.wardName} stays blocked. Members on it will still have no constituency ancestry until the reference data is corrected.`
        }
        confirmLabel={pending === "approve" ? "Approve" : "Reject"}
        onConfirm={() => decide(pending === "approve" ? "approve" : "reject")}
        onCancel={() => setPending(null)}
      />
    </main>
  );
}
