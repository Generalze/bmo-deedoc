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
      <main className="shell">
        <section className="panel hero">
          <h1>Loading election-day reporting...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load election-day reporting</h1>
          <FeedbackBanner tone={feedback.tone} message={feedback.message || "Authentication is required."} />
          <Link href="/agent/dashboard">Return to agent dashboard</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Election-day reporting</p>
        <h1>Submit polling-unit report</h1>
        <p>Polling unit: {user.agentProfile?.pollingUnitId || "Not assigned"}</p>
        <p className="muted">This report is locked to your assigned polling-unit territory.</p>
      </section>

      <FeedbackBanner tone={feedback.tone} message={feedback.message} />

      <section className="panel card">
        <h2>Report details</h2>
        <form className="form" onSubmit={handleSubmit}>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <label className="field">
              <span>Report date</span>
              <input type="date" value={form.reportDate} onChange={(event) => setForm({ ...form, reportDate: event.target.value })} required />
            </label>
            <label className="field">
              <span>Arrival confirmation time</span>
              <input type="datetime-local" value={form.arrivalConfirmedAt} onChange={(event) => setForm({ ...form, arrivalConfirmedAt: event.target.value })} required />
            </label>
            <label className="field">
              <span>Opening status</span>
              <select value={form.openingStatus} onChange={(event) => setForm({ ...form, openingStatus: event.target.value as typeof form.openingStatus })}>
                {openingStatuses.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Turnout observation</span>
            <textarea rows={4} value={form.turnoutObservation} onChange={(event) => setForm({ ...form, turnoutObservation: event.target.value })} required />
          </label>
          <label className="field">
            <span>Incident notes</span>
            <textarea rows={3} value={form.incidentNotes} onChange={(event) => setForm({ ...form, incidentNotes: event.target.value })} />
          </label>
          <label className="field">
            <span>Remarks</span>
            <textarea rows={3} value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} />
          </label>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <label className="field">
              <span>Arrival Photo</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setArrivalPhoto(event.target.files?.[0] || null)} required />
            </label>
            <label className="field">
              <span>Post-Counting Photo</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPostCountingPhoto(event.target.files?.[0] || null)} required />
            </label>
          </div>

          <section className="panel card" style={{ padding: 18 }}>
            <h2 style={{ marginTop: 0 }}>Top 5 party vote entry</h2>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              {voteEntries.map((entry, index) => (
                <div key={`vote-entry-${index}`} className="field">
                  <span>Party {index + 1}</span>
                  <select value={entry.politicalPartyId} onChange={(event) => updateVoteEntry(index, { politicalPartyId: event.target.value })} required>
                    <option value="">Select party</option>
                    {parties.map((party) => (
                      <option key={party.id} value={party.id}>{party.name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    placeholder="Votes"
                    value={entry.votes}
                    onChange={(event) => updateVoteEntry(index, { votes: event.target.value })}
                    required
                  />
                </div>
              ))}
            </div>
            {duplicatePartySelection ? <p className="error">Each vote entry must use a different party.</p> : null}
          </section>

          <div className="action-row">
            <button className="button" type="submit" disabled={submitting}>
              {submitting ? "Submitting..." : "Submit Election Report"}
            </button>
            <Link href="/agent/dashboard" className="button secondary">Back to Dashboard</Link>
          </div>
        </form>
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <div className="section-head">
          <div>
            <h2>Recent reports</h2>
            <p className="muted">Your most recent election-day submissions and review status.</p>
          </div>
          <span className="status-pill">{reports.length} reports</span>
        </div>
        {reports.length === 0 ? (
          <p className="muted">No election-day reports submitted yet.</p>
        ) : (
          <div className="reward-list">
            {reports.map((report) => (
              <article key={report.id} className="reward-item">
                <strong>{new Date(report.reportDate).toLocaleDateString()} | {report.status}</strong>
                <p className="muted">Opening: {report.openingStatus} | Arrival: {new Date(report.arrivalConfirmedAt).toLocaleString()}</p>
                <p>{report.turnoutObservation}</p>
                {report.reviewNote ? <p className="muted">Review note: {report.reviewNote}</p> : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
