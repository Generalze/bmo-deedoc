"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AuthUserProfile, ElectionDayReportItem } from "@pics-nigeria/shared";
import {
  ApiError,
  fetchAdminElectionDayReportAsset,
  fetchAdminElectionDayReports,
  fetchCurrentUser,
  updateAdminElectionDayReportStatus,
} from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { describeTerritory } from "../../../components/admin-management-utils";
import { FeedbackBanner } from "../../../components/feedback-banner";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import {
  DataTable,
  DetailList,
  EmptyRow,
  Field,
  PageHead,
  Panel,
  StateView,
  StatusPill,
  Toolbar,
  ToolbarEnd,
  ToolbarField,
  formatCount,
} from "../../../components/ui";
import { readSession } from "../../../lib/session";

const statusOptions = ["", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"] as const;

export default function AdminElectionReportsPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [reports, setReports] = useState<ElectionDayReportItem[]>([]);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string }>({ tone: "success", message: "" });
  const [status, setStatus] = useState("");
  const [reportDate, setReportDate] = useState("");
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
  const [confirmState, setConfirmState] = useState<{ reportId: string; status: "UNDER_REVIEW" | "APPROVED" | "REJECTED" } | null>(null);

  async function loadPage(token: string, nextStatus?: string, nextReportDate?: string) {
    const [currentUser, nextReports] = await Promise.all([
      fetchCurrentUser(token),
      fetchAdminElectionDayReports(token, {
        status: (nextStatus || undefined) as "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | undefined,
        reportDate: nextReportDate || undefined,
      }),
    ]);

    if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
      throw new ApiError("This page is available to admins only.", 403);
    }

    setUser(currentUser);
    setReports(nextReports);
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    loadPage(token, status, reportDate)
      .catch((caughtError) =>
        setFeedback({
          tone: "error",
          message: caughtError instanceof Error ? caughtError.message : "Could not load election-day reports.",
        }))
      .finally(() => setLoading(false));
  }, []);

  async function handleApplyFilters() {
    const token = readSession();
    if (!token) {
      setFeedback({ tone: "error", message: "Authentication is required." });
      return;
    }

    try {
      setLoading(true);
      setFeedback({ tone: "success", message: "" });
      await loadPage(token, status, reportDate);
    } catch (caughtError) {
      setFeedback({
        tone: "error",
        message: caughtError instanceof Error ? caughtError.message : "Could not filter election-day reports.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleStatusUpdate() {
    if (!confirmState) {
      return;
    }

    const token = readSession();
    if (!token) {
      setFeedback({ tone: "error", message: "Authentication is required." });
      return;
    }

    try {
      setActionBusy(true);
      const result = await updateAdminElectionDayReportStatus(token, confirmState.reportId, {
        status: confirmState.status,
        reviewNote: reviewDrafts[confirmState.reportId] || undefined,
      });
      setFeedback({ tone: "success", message: result.message });
      setConfirmState(null);
      await loadPage(token, status, reportDate);
    } catch (caughtError) {
      setFeedback({
        tone: "error",
        message: caughtError instanceof Error ? caughtError.message : "Could not update election-day report status.",
      });
    } finally {
      setActionBusy(false);
    }
  }

  async function openAsset(assetId: string) {
    const token = readSession();
    if (!token) {
      setFeedback({ tone: "error", message: "Authentication is required." });
      return;
    }

    try {
      const blob = await fetchAdminElectionDayReportAsset(token, assetId);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caughtError) {
      setFeedback({
        tone: "error",
        message: caughtError instanceof Error ? caughtError.message : "Could not open election-day report photo.",
      });
    }
  }
  if (loading && !user) {
    return (
      <main className="console-shell">
        <PageHead title="Election-day reports" />
        <StateView kind="loading" title="Loading election-day reports…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Election-day reports" />
        <StateView
          kind="error"
          title="Unable to load election-day reports"
          detail={feedback.message || "Authentication is required."}
          action={
            <Link className="btn btn-primary" href="/admin/dashboard">
              Return to admin overview
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <main className="console-shell">
      <PageHead
        title="Review Polling Unit submissions"
        lead={`Visible scope: ${describeTerritory(
          user.adminProfile || {
            geoPoliticalZoneId: null,
            stateId: null,
            senatorialDistrictId: null,
            federalConstituencyId: null,
            lgaId: null,
            wardId: null,
            stateConstituencyId: null,
            pollingUnitId: null,
          },
        )}`}
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        <FeedbackBanner tone={feedback.tone} message={feedback.message} />

        <Panel title="Scoped reports" meta={`${formatCount(reports.length)} visible`} flush>
          <Toolbar>
            <ToolbarField label="Status">
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                {statusOptions.map((option) => (
                  <option key={option || "all"} value={option}>
                    {option ? option.replace(/_/g, " ").toLowerCase() : "All visible statuses"}
                  </option>
                ))}
              </select>
            </ToolbarField>
            <ToolbarField label="Report date">
              <input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
            </ToolbarField>
            <ToolbarEnd>
              <button className="btn btn-sm btn-primary" type="button" onClick={() => void handleApplyFilters()} disabled={loading}>
                {loading ? "Loading…" : "Apply"}
              </button>
            </ToolbarEnd>
          </Toolbar>

          <div className="panel-body">
            <p className="muted-text">
              Review status changes are permission-checked on the backend and limited to your visible territory.
            </p>
          </div>

          <DataTable
            head={
              <tr>
                <th>Agent</th>
                <th>Polling Unit</th>
                <th>Status</th>
                <th>Opening</th>
                <th>Report date</th>
                <th className="actions">Action</th>
              </tr>
            }
          >
            {reports.length === 0 ? (
              <EmptyRow colSpan={6}>No election-day reports are visible for the current filter.</EmptyRow>
            ) : (
              reports.flatMap((report) => {
                const open = expandedReportId === report.id;
                const rows = [
                  <tr key={report.id} className={open ? "row-open" : undefined}>
                    <td>
                      <strong>{report.agentName}</strong>
                      <div className="muted-text">
                        Arrived {new Date(report.arrivalConfirmedAt).toLocaleString()}
                      </div>
                    </td>
                    <td className="mono">{report.territory.pollingUnitId}</td>
                    <td>
                      <StatusPill status={report.status} />
                    </td>
                    <td className="muted-text">{report.openingStatus.replace(/_/g, " ").toLowerCase()}</td>
                    <td className="muted-text">{new Date(report.reportDate).toLocaleDateString()}</td>
                    <td className="actions">
                      <button
                        className="btn btn-sm"
                        type="button"
                        aria-expanded={open}
                        onClick={() => setExpandedReportId(open ? null : report.id)}
                      >
                        {open ? "Close" : "Review"}
                      </button>
                    </td>
                  </tr>,
                ];

                if (open) {
                  rows.push(
                    <tr key={`${report.id}-detail`} className="row-editor">
                      <td colSpan={6}>
                        <div className="stack-3">
                          <DetailList
                            rows={[
                              { label: "Turnout observation", value: report.turnoutObservation },
                              report.incidentNotes ? { label: "Incident notes", value: report.incidentNotes } : null,
                              report.remarks ? { label: "Remarks", value: report.remarks } : null,
                              report.reviewNote ? { label: "Current review note", value: report.reviewNote } : null,
                            ]}
                          />

                          <DataTable
                            caption="Recorded votes by party"
                            head={
                              <tr>
                                <th>Party</th>
                                <th className="numeric">Votes</th>
                              </tr>
                            }
                          >
                            {report.voteEntries.length === 0 ? (
                              <EmptyRow colSpan={2}>No vote entries recorded.</EmptyRow>
                            ) : (
                              report.voteEntries.map((entry) => (
                                <tr key={`${report.id}-${entry.politicalPartyId}`}>
                                  <td>{entry.politicalPartyName || entry.politicalPartyId}</td>
                                  <td className="numeric">{formatCount(entry.votes)}</td>
                                </tr>
                              ))
                            )}
                          </DataTable>

                          <div className="btn-row">
                            <button className="btn btn-sm" type="button" onClick={() => void openAsset(report.arrivalPhotoAssetId)}>
                              Arrival photo
                            </button>
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() => void openAsset(report.postCountingPhotoAssetId)}
                            >
                              Post-counting photo
                            </button>
                            <Link className="btn btn-sm" href={`/admin/evidence?electionReportId=${encodeURIComponent(report.id)}`}>
                              Linked evidence
                            </Link>
                            {report.territory.pollingUnitId ? (
                              <Link
                                className="btn btn-sm"
                                href={`/admin/evidence?pollingUnitId=${encodeURIComponent(report.territory.pollingUnitId)}`}
                              >
                                PU dossier
                              </Link>
                            ) : null}
                          </div>

                          <Field label="Review note">
                            <textarea
                              rows={3}
                              value={reviewDrafts[report.id] || ""}
                              onChange={(event) =>
                                setReviewDrafts((current) => ({ ...current, [report.id]: event.target.value }))
                              }
                            />
                          </Field>

                          <div className="btn-row">
                            <button
                              className="btn"
                              type="button"
                              onClick={() => setConfirmState({ reportId: report.id, status: "UNDER_REVIEW" })}
                            >
                              Mark under review
                            </button>
                            <button
                              className="btn btn-primary"
                              type="button"
                              onClick={() => setConfirmState({ reportId: report.id, status: "APPROVED" })}
                            >
                              Approve
                            </button>
                            <button
                              className="btn btn-danger"
                              type="button"
                              onClick={() => setConfirmState({ reportId: report.id, status: "REJECTED" })}
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>,
                  );
                }

                return rows;
              })
            )}
          </DataTable>
        </Panel>
      </div>

      <ConfirmDialog
        open={Boolean(confirmState)}
        title="Confirm status update"
        description={
          confirmState
            ? `Update this election-day report to ${confirmState.status.replaceAll("_", " ").toLowerCase()}?`
            : ""
        }
        confirmLabel="Confirm Update"
        onCancel={() => setConfirmState(null)}
        onConfirm={() => void handleStatusUpdate()}
        busy={actionBusy}
      />
    </main>
  );
}
