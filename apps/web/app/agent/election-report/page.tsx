"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AuthUserProfile, ElectionDayReportItem, PoliticalPartyItem } from "@pics-nigeria/shared";
import {
  ApiError,
  createAgentElectionDayReport,
  fetchAgentElectionDayReports,
  fetchCurrentUser,
  fetchPublicParties,
  uploadAgentElectionReportPhoto,
} from "../../../lib/api";
import { FeedbackBanner } from "../../../components/feedback-banner";
import { DataTable, EmptyRow, Field, PageHead, Panel, StateView, StatusPill, formatCount } from "../../../components/ui";
import { readSession } from "../../../lib/session";

const openingStatuses = [
  { value: "OPENED_ON_TIME", label: "Opened on time" },
  { value: "OPENED_LATE", label: "Opened late" },
  { value: "NOT_OPEN", label: "Did not open" },
] as const;

function buildInitialVoteEntries(parties: PoliticalPartyItem[]) {
  return Array.from({ length: 5 }).map((_, index) => ({
    politicalPartyId: parties[index]?.id || "",
    votes: "",
  }));
}

export default function AgentElectionReportPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [reports, setReports] = useState<ElectionDayReportItem[]>([]);
  const [parties, setParties] = useState<PoliticalPartyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string }>({ tone: "success", message: "" });
  const [form, setForm] = useState({
    reportDate: new Date().toISOString().slice(0, 10),
    arrivalConfirmedAt: new Date().toISOString().slice(0, 16),
    openingStatus: "OPENED_ON_TIME" as "OPENED_ON_TIME" | "OPENED_LATE" | "NOT_OPEN",
    turnoutObservation: "",
    incidentNotes: "",
    remarks: "",
  });
  const [voteEntries, setVoteEntries] = useState<Array<{ politicalPartyId: string; votes: string }>>([]);
  const [arrivalPhoto, setArrivalPhoto] = useState<File | null>(null);
  const [postCountingPhoto, setPostCountingPhoto] = useState<File | null>(null);

  async function loadPage(token: string) {
    const [currentUser, nextReports, nextParties] = await Promise.all([
      fetchCurrentUser(token),
      fetchAgentElectionDayReports(token),
      fetchPublicParties(),
    ]);

    const hasPollingUnitFieldAccess =
      currentUser.role === "AGENT" ||
      (currentUser.role === "COORDINATOR" && currentUser.coordinatorProfile?.level === "POLLING_UNIT" && currentUser.agentProfile);
    if (!hasPollingUnitFieldAccess) {
      throw new ApiError("This page is available to Polling Unit field coordinators only.", 403);
    }

    setUser(currentUser);
    setReports(nextReports);
    setParties(nextParties.filter((party) => party.isApprovedByInec));
    setVoteEntries((current) => (current.length === 5 ? current : buildInitialVoteEntries(nextParties.filter((party) => party.isApprovedByInec))));
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login?field=1";
      return;
    }

    loadPage(token)
      .catch((caughtError) =>
        setFeedback({
          tone: "error",
          message: caughtError instanceof Error ? caughtError.message : "Could not load election-day reporting.",
        }))
      .finally(() => setLoading(false));
  }, []);

  const duplicatePartySelection = useMemo(() => {
    const selected = voteEntries.map((entry) => entry.politicalPartyId).filter(Boolean);
    return new Set(selected).size !== selected.length;
  }, [voteEntries]);

  function updateVoteEntry(index: number, nextEntry: Partial<{ politicalPartyId: string; votes: string }>) {
    setFeedback({ tone: "success", message: "" });
    setVoteEntries((current) => current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...nextEntry } : entry)));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token) {
      setFeedback({ tone: "error", message: "Authentication is required." });
      return;
    }

    if (!arrivalPhoto || !postCountingPhoto) {
      setFeedback({ tone: "error", message: "Arrival photo and post-counting photo are required." });
      return;
    }

    if (duplicatePartySelection || voteEntries.some((entry) => !entry.politicalPartyId || entry.votes === "")) {
      setFeedback({ tone: "error", message: "Select five different parties and enter vote totals for all of them." });
      return;
    }

    try {
      setSubmitting(true);
      setFeedback({ tone: "success", message: "" });

      const [arrivalAsset, postCountingAsset] = await Promise.all([
        uploadAgentElectionReportPhoto(token, "arrival-photo", arrivalPhoto),
        uploadAgentElectionReportPhoto(token, "post-counting-photo", postCountingPhoto),
      ]);

      const result = await createAgentElectionDayReport(token, {
        reportDate: form.reportDate,
        arrivalConfirmedAt: new Date(form.arrivalConfirmedAt).toISOString(),
        openingStatus: form.openingStatus,
        turnoutObservation: form.turnoutObservation,
        incidentNotes: form.incidentNotes || undefined,
        remarks: form.remarks || undefined,
        arrivalPhotoAssetId: arrivalAsset.asset.id,
        postCountingPhotoAssetId: postCountingAsset.asset.id,
        voteEntries: voteEntries.map((entry) => ({
          politicalPartyId: entry.politicalPartyId,
          votes: Number(entry.votes),
        })),
      });

      setFeedback({ tone: "success", message: result.message });
      setArrivalPhoto(null);
      setPostCountingPhoto(null);
      setForm((current) => ({
        ...current,
        turnoutObservation: "",
        incidentNotes: "",
        remarks: "",
      }));
      await loadPage(token);
    } catch (caughtError) {
      setFeedback({
        tone: "error",
        message: caughtError instanceof Error ? caughtError.message : "Election-day report submission failed.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Submit Polling Unit report" />
        <StateView kind="loading" title="Loading election-day reporting…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Submit Polling Unit report" />
        <StateView
          kind="error"
          title="Unable to load election-day reporting"
          detail={feedback.message || "Authentication is required."}
          action={
            <Link className="btn btn-primary" href="/agent/dashboard">
              Return to your dashboard
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <main className="console-shell form-page">
      <PageHead
        title="Submit Polling Unit report"
        lead={`Polling Unit: ${user.agentProfile?.pollingUnitId || "Not assigned"} · This report is locked to your assigned Polling Unit territory.`}
        actions={
          <Link className="btn" href="/agent/dashboard">
            Back to dashboard
          </Link>
        }
      />

      <div className="stack-4">
        <FeedbackBanner tone={feedback.tone} message={feedback.message} />

        <Panel title="Report details">
          <form className="stack-3" onSubmit={handleSubmit}>
            <div className="form-grid">
              <Field label="Report date">
                <input
                  type="date"
                  value={form.reportDate}
                  onChange={(event) => setForm({ ...form, reportDate: event.target.value })}
                  required
                />
              </Field>
              <Field label="Arrival confirmation time">
                <input
                  type="datetime-local"
                  value={form.arrivalConfirmedAt}
                  onChange={(event) => setForm({ ...form, arrivalConfirmedAt: event.target.value })}
                  required
                />
              </Field>
              <Field label="Opening status">
                <select
                  value={form.openingStatus}
                  onChange={(event) => setForm({ ...form, openingStatus: event.target.value as typeof form.openingStatus })}
                >
                  {openingStatuses.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Turnout observation">
              <textarea
                rows={4}
                value={form.turnoutObservation}
                onChange={(event) => setForm({ ...form, turnoutObservation: event.target.value })}
                required
              />
            </Field>
            <Field label="Incident notes" hint="Optional.">
              <textarea
                rows={3}
                value={form.incidentNotes}
                onChange={(event) => setForm({ ...form, incidentNotes: event.target.value })}
              />
            </Field>
            <Field label="Remarks" hint="Optional.">
              <textarea rows={3} value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} />
            </Field>

            <div className="form-grid">
              <Field label="Arrival photo" hint="JPG, PNG or WebP.">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => setArrivalPhoto(event.target.files?.[0] || null)}
                  required
                />
              </Field>
              <Field label="Post-counting photo" hint="JPG, PNG or WebP.">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => setPostCountingPhoto(event.target.files?.[0] || null)}
                  required
                />
              </Field>
            </div>

            <fieldset className="kpi" style={{ border: "1px solid var(--line)" }}>
              <legend className="kpi-label">Top 5 party vote entry</legend>
              <div className="form-grid">
                {voteEntries.map((entry, index) => (
                  <Field
                    key={`vote-entry-${index}`}
                    label={`Party ${index + 1}`}
                    error={index === 0 && duplicatePartySelection ? "Each vote entry must use a different party." : undefined}
                  >
                    <select
                      value={entry.politicalPartyId}
                      onChange={(event) => updateVoteEntry(index, { politicalPartyId: event.target.value })}
                      required
                    >
                      <option value="">Select party</option>
                      {parties.map((party) => (
                        <option key={party.id} value={party.id}>
                          {party.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={0}
                      inputMode="numeric"
                      placeholder="Votes"
                      aria-label={`Votes for party ${index + 1}`}
                      value={entry.votes}
                      onChange={(event) => updateVoteEntry(index, { votes: event.target.value })}
                      required
                    />
                  </Field>
                ))}
              </div>
            </fieldset>

            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={submitting || duplicatePartySelection}>
                {submitting ? "Submitting…" : "Submit election report"}
              </button>
            </div>
          </form>
        </Panel>

        <Panel title="Your recent reports" meta={`${formatCount(reports.length)} submitted`} flush>
          <DataTable
            head={
              <tr>
                <th>Report date</th>
                <th>Status</th>
                <th>Opening</th>
                <th>Arrival</th>
                <th>Observation</th>
              </tr>
            }
          >
            {reports.length === 0 ? (
              <EmptyRow colSpan={5}>No election-day reports submitted yet.</EmptyRow>
            ) : (
              reports.map((report) => (
                <tr key={report.id}>
                  <td>{new Date(report.reportDate).toLocaleDateString()}</td>
                  <td>
                    <StatusPill status={report.status} />
                  </td>
                  <td className="muted-text">{report.openingStatus.replace(/_/g, " ").toLowerCase()}</td>
                  <td className="muted-text">{new Date(report.arrivalConfirmedAt).toLocaleString()}</td>
                  <td className="muted-text">
                    {report.turnoutObservation}
                    {report.reviewNote ? <div>Review note: {report.reviewNote}</div> : null}
                  </td>
                </tr>
              ))
            )}
          </DataTable>
        </Panel>
      </div>
    </main>
  );
}
