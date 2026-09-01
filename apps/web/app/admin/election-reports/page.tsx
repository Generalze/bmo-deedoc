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
import { readSession } from "../../../lib/session";

const statusOptions = ["", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"] as const;

export default function AdminElectionReportsPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [reports, setReports] = useState<ElectionDayReportItem[]>([]);
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
      <main className="shell">
        <section className="panel hero">
          <h1>Loading election-day reports...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load election-day reports</h1>
          <FeedbackBanner tone={feedback.tone} message={feedback.message || "Authentication is required."} />
          <Link href="/admin/dashboard">Return to admin overview</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Election-day reporting</p>
        <h1>Review polling-unit submissions</h1>
        <p>Visible scope: {describeTerritory(user.adminProfile || {
          geoPoliticalZoneId: null,
          stateId: null,
          senatorialDistrictId: null,
          federalConstituencyId: null,
          lgaId: null,
          wardId: null,
          stateConstituencyId: null,
          pollingUnitId: null,
        })}</p>
      </section>

      <AdminNav role={user?.role} />
      <FeedbackBanner tone={feedback.tone} message={feedback.message} />

      <section className="panel card">
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {statusOptions.map((option) => (
                <option key={option || "all"} value={option}>
                  {option || "All visible statuses"}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Report date</span>
            <input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
          </label>
        </div>
        <div className="action-row" style={{ marginTop: 16 }}>
          <button className="button" type="button" onClick={() => void handleApplyFilters()} disabled={loading}>
            {loading ? "Loading..." : "Apply filters"}
          </button>
        </div>
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <div className="section-head">
          <div>
            <h2>Scoped reports</h2>
            <p className="muted">Review status changes are permission-checked on the backend and limited to your visible territory.</p>
          </div>
          <span className="status-pill">{reports.length} visible</span>
        </div>

        {reports.length === 0 ? (
          <p className="muted">No election-day reports are visible for the current filter.</p>
        ) : (
          <div className="reward-list">
            {reports.map((report) => (
              <article key={report.id} className="reward-item">
                <strong>{report.agentName}</strong>
                <p>{report.status} | {new Date(report.reportDate).toLocaleDateString()} | {report.territory.pollingUnitId}</p>
                <p className="muted">
                  Opening: {report.openingStatus} | Arrival: {new Date(report.arrivalConfirmedAt).toLocaleString()}
                </p>
                <p>{report.turnoutObservation}</p>
                {report.incidentNotes ? <p className="muted">Incident notes: {report.incidentNotes}</p> : null}
                {report.remarks ? <p className="muted">Remarks: {report.remarks}</p> : null}
                <div className="reward-list" style={{ marginTop: 10 }}>
                  {report.voteEntries.map((entry) => (
                    <article key={`${report.id}-${entry.politicalPartyId}`} className="reward-item">
                      <strong>{entry.politicalPartyName || entry.politicalPartyId}</strong>
                      <p>{entry.votes} votes</p>
                    </article>
                  ))}
                </div>
                <div className="action-row" style={{ marginTop: 12 }}>
                  <button className="button secondary" type="button" onClick={() => void openAsset(report.arrivalPhotoAssetId)}>
                    View Arrival Photo
                  </button>
                  <button className="button secondary" type="button" onClick={() => void openAsset(report.postCountingPhotoAssetId)}>
                    View Post-Counting Photo
                  </button>
                  <Link href={`/admin/evidence?electionReportId=${encodeURIComponent(report.id)}`}>
                    Open linked evidence
                  </Link>
                  {report.territory.pollingUnitId ? (
                    <Link href={`/admin/evidence?pollingUnitId=${encodeURIComponent(report.territory.pollingUnitId)}`}>
                      Open PU dossier
                    </Link>
                  ) : null}
                </div>
                <label className="field" style={{ marginTop: 12 }}>
                  <span>Review note</span>
                  <textarea
                    rows={3}
                    value={reviewDrafts[report.id] || ""}
                    onChange={(event) => setReviewDrafts((current) => ({ ...current, [report.id]: event.target.value }))}
                  />
                </label>
                <div className="action-row">
                  <button className="button secondary" type="button" onClick={() => setConfirmState({ reportId: report.id, status: "UNDER_REVIEW" })}>
                    Mark Under Review
                  </button>
                  <button className="button" type="button" onClick={() => setConfirmState({ reportId: report.id, status: "APPROVED" })}>
                    Approve
                  </button>
                  <button className="button danger" type="button" onClick={() => setConfirmState({ reportId: report.id, status: "REJECTED" })}>
                    Reject
                  </button>
                </div>
                {report.reviewNote ? <p className="muted">Current review note: {report.reviewNote}</p> : null}
              </article>
            ))}
          </div>
        )}
      </section>

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
