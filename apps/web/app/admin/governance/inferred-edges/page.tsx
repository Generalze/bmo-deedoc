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
import {
  DataTable,
  DetailList,
  EmptyRow,
  Field,
  Kpi,
  KpiRow,
  Notice,
  PageHead,
  Panel,
  StateView,
  Toolbar,
  formatCount,
} from "../../../../components/ui";
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
      <main className="console-shell">
        <AdminNav />
        <PageHead title="Inferred constituency edges" />
        <StateView kind="refused" title="Restricted" detail="This review is restricted to the Super Admin." />
      </main>
    );
  }

  const reasonTooShort = reason.trim().length < 10;

  return (
    <main className="console-shell">
      <AdminNav />

      <PageHead
        title="Inferred constituency edges"
        lead="These wards were matched to a State Constituency by inference rather than read from an authoritative source. Until a reviewer confirms one, members on that ward cannot be given constituency ancestry and are not counted at State Constituency, Federal Constituency or Senatorial District level."
      />

      <div className="stack-4">
        {error ? <FeedbackBanner tone="error" message={error} /> : null}
        {message ? <FeedbackBanner tone="success" message={message} /> : null}

        <Notice tone="legacy" title="What each decision records">
          <span>
            Approving records that you checked this exact mapping. Rejecting records that it is wrong and leaves the
            ward blocked — correcting it is a reference-data change, not something this screen can do.
          </span>
        </Notice>

        {summary ? (
          <KpiRow>
            <Kpi
              label="Awaiting review"
              value={formatCount(summary.pending)}
              note="Wards blocked from constituency ancestry"
              tone={summary.pending > 0 ? "accent" : undefined}
            />
            <Kpi label="Approved" value={formatCount(summary.approved)} note="Confirmed against a source" />
            <Kpi label="Rejected" value={formatCount(summary.rejected)} note="Still blocked" />
            <Kpi label="Inferred edges" value={formatCount(summary.total)} />
          </KpiRow>
        ) : null}

        <Panel title="Edges" meta={`${formatCount(edges.length)} in this state`} flush>
          <Toolbar>
            <span className="cluster">
              {FILTERS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={filter === item.key ? "btn btn-sm btn-primary" : "btn btn-sm"}
                  aria-pressed={filter === item.key}
                  onClick={() => setFilter(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </span>
          </Toolbar>

          {loading ? (
            <div className="panel-body">
              <StateView kind="loading" title="Loading edges…" />
            </div>
          ) : (
            <DataTable
              head={
                <tr>
                  <th>Ward</th>
                  <th>Inferred chain</th>
                  <th>Basis</th>
                  <th className="numeric">Impact</th>
                  <th>State</th>
                  <th className="actions">Action</th>
                </tr>
              }
            >
              {edges.length === 0 ? (
                <EmptyRow colSpan={6}>No edges in this state.</EmptyRow>
              ) : (
                edges.map((edge) => (
                  <tr key={edge.wardId}>
                    <td>
                      <strong>{edge.wardName}</strong>
                      <div className="muted-text">{edge.lga?.name ?? "Unknown LGA"}</div>
                    </td>
                    <td className="muted-text">
                      {edge.stateConstituency?.name ?? "No constituency"}
                      {edge.stateConstituency?.federalConstituency
                        ? ` → ${edge.stateConstituency.federalConstituency.name}`
                        : ""}
                      {edge.stateConstituency?.federalConstituency?.senatorialDistrict
                        ? ` → ${edge.stateConstituency.federalConstituency.senatorialDistrict.name}`
                        : ""}
                    </td>
                    <td className="muted-text">{edge.inferenceBasis ?? "not recorded"}</td>
                    <td className="numeric">
                      {formatCount(edge.impact.members)} members
                      <div className="muted-text">{formatCount(edge.impact.coordinators)} coordinators</div>
                    </td>
                    <td>
                      <span className={edge.operational ? "pill pill-executed" : "pill pill-refused"}>
                        {edge.operational ? "operational" : "blocked"}
                      </span>
                      <div className="muted-text">{edge.reviewState.toLowerCase()}</div>
                      {edge.decision ? (
                        <div className="muted-text" title={edge.decision.reason}>
                          {edge.decision.outcome === "APPROVED" ? "Approved" : "Rejected"} by{" "}
                          {edge.decision.reviewer?.name ?? "unknown"}
                        </div>
                      ) : null}
                    </td>
                    <td className="actions">
                      <button
                        className="btn btn-sm"
                        type="button"
                        onClick={() => {
                          setSelected(edge);
                          setReason("");
                        }}
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          )}
        </Panel>

        {selected ? (
          <Panel
            title={selected.wardName}
            meta={`Deciding whether it belongs to ${selected.stateConstituency?.name ?? "no constituency"}`}
          >
            <div className="stack-3">
              <DetailList
                rows={[
                  {
                    label: "INEC delimitation",
                    value: selected.sourceEvidence.inecDelimitation
                      ? `${selected.sourceEvidence.inecDelimitation.name} (${selected.sourceEvidence.inecDelimitation.code})`
                      : "no record",
                  },
                  {
                    label: "Workbook spelling",
                    value: selected.sourceEvidence.constituencyWorkbook
                      ? selected.sourceEvidence.constituencyWorkbook.aliases.join(", ")
                      : "no differing spelling recorded",
                  },
                  {
                    label: "Constituency source code",
                    value: selected.sourceEvidence.constituencySourceCode
                      ? selected.sourceEvidence.constituencySourceCode.code
                      : "no record",
                  },
                  { label: "Inference basis", value: selected.inferenceBasis ?? "not recorded" },
                  {
                    label: "Impact today",
                    value: `${formatCount(selected.impact.members)} members, ${formatCount(selected.impact.coordinators)} coordinators. Coordinators are shown for context only; this decision does not change them.`,
                  },
                  { label: "Note", value: selected.sourceEvidence.note },
                ]}
              />

              <Field
                label="Reason"
                hint="Recorded permanently, minimum 10 characters."
                error={reasonTooShort ? "A reason is required before either decision." : undefined}
              >
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  placeholder="What did you check, and what did you conclude?"
                />
              </Field>

              <div className="btn-row">
                <button className="btn btn-primary" type="button" disabled={reasonTooShort} onClick={() => setPending("approve")}>
                  Approve this edge
                </button>
                <button className="btn btn-danger" type="button" disabled={reasonTooShort} onClick={() => setPending("reject")}>
                  Reject this edge
                </button>
                <button className="btn" type="button" onClick={() => setSelected(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </Panel>
        ) : null}
      </div>

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
