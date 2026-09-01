"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  INCIDENT_TYPES,
  type AuthUserProfile,
  type IncidentGovernanceSummary,
  type IncidentListItem,
} from "@pics-nigeria/shared";
import { ApiError, fetchAdminIncidentReview, fetchCurrentUser } from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { describeTerritory } from "../../../components/admin-management-utils";
import { readSession } from "../../../lib/session";

const statusOptions = ["", "OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] as const;
const reviewPriorityOptions = ["", "ROUTINE", "PRIORITY", "CRITICAL"] as const;

export default function AdminIncidentsPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [incidents, setIncidents] = useState<IncidentListItem[]>([]);
  const [governance, setGovernance] = useState<IncidentGovernanceSummary | null>(null);
  const [status, setStatus] = useState("");
  const [incidentType, setIncidentType] = useState("");
  const [reviewPriority, setReviewPriority] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadPage(
    token: string,
    nextStatus?: string,
    nextIncidentType?: string,
    nextReviewPriority?: string,
    nextFlaggedOnly?: boolean,
  ) {
    const [currentUser, review] = await Promise.all([
      fetchCurrentUser(token),
      fetchAdminIncidentReview(token, {
        status: nextStatus || undefined,
        type: nextIncidentType || undefined,
        reviewPriority: (nextReviewPriority || undefined) as "ROUTINE" | "PRIORITY" | "CRITICAL" | undefined,
        flaggedOnly: nextFlaggedOnly,
      }),
    ]);

    if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
      throw new ApiError("This page is available to admins only.", 403);
    }

    setUser(currentUser);
    setIncidents(review.incidents);
    setGovernance(review.governance);
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    loadPage(token, status, incidentType, reviewPriority, flaggedOnly)
      .catch((caughtError) => setError(caughtError instanceof Error ? caughtError.message : "Could not load incident review."))
      .finally(() => setLoading(false));
  }, []);

  async function handleApplyFilters() {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      await loadPage(token, status, incidentType, reviewPriority, flaggedOnly);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not filter incidents.");
    } finally {
      setLoading(false);
    }
  }

  const topFlags = useMemo(() => {
    if (!governance) {
      return [];
    }

    return Object.entries(governance.byFlagCode)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4);
  }, [governance]);

  if (loading && !user) {
    return (
      <main className="shell">
        <section className="panel hero">
          <h1>Loading incident review...</h1>
        </section>
      </main>
    );
  }

  if (!user || !governance) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load incident review</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/admin/dashboard">Return to admin overview</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Incident governance</p>
        <h1>Incident review queue</h1>
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
      {error ? <p className="error">{error}</p> : null}

      <section className="grid stats">
        <article className="panel card">
          <h2>Total incidents</h2>
          <div className="value">{governance.totalIncidents}</div>
        </article>
        <article className="panel card">
          <h2>Flagged incidents</h2>
          <div className="value">{governance.flaggedIncidents}</div>
        </article>
        <article className="panel card">
          <h2>Critical review</h2>
          <div className="value">{governance.criticalReviewIncidents}</div>
        </article>
        <article className="panel card">
          <h2>Escalated</h2>
          <div className="value">{governance.escalatedIncidents}</div>
        </article>
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
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
            <span>Incident type</span>
            <select value={incidentType} onChange={(event) => setIncidentType(event.target.value)}>
              <option value="">All visible incident types</option>
              {INCIDENT_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Review priority</span>
            <select value={reviewPriority} onChange={(event) => setReviewPriority(event.target.value)}>
              {reviewPriorityOptions.map((option) => (
                <option key={option || "all"} value={option}>
                  {option || "All review priorities"}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-field" style={{ alignSelf: "end" }}>
            <input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} />
            <span>Show flagged incidents only</span>
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
            <h2>Review signals</h2>
            <p className="muted">Signals are advisory. They surface potential duplicate, territory mismatch, assignment, and evidence gaps without blocking submissions.</p>
          </div>
          <span className="status-pill">{incidents.length} visible</span>
        </div>
        {topFlags.length ? (
          <div className="badges" style={{ marginTop: 12, marginBottom: 12 }}>
            {topFlags.map(([code, count]) => (
              <span key={code} className="status-pill">
                {code}: {count}
              </span>
            ))}
          </div>
        ) : null}

        {incidents.length === 0 ? (
          <p className="muted">No incidents match the current review filter.</p>
        ) : (
          <div className="reward-list">
            {incidents.map((incident) => (
              <article key={incident.id} className="reward-item">
                <strong>{incident.title}</strong>
                <p>{incident.type} | {incident.severity} | {incident.status}</p>
                <p className="muted">
                  Reporter: {incident.governance?.reporterRole || "Unknown"} | Review priority: {incident.governance?.reviewPriority || "ROUTINE"} | Escalation: {incident.governance?.escalationStatus || "NOT_ESCALATED"}
                </p>
                <p className="muted">
                  {new Date(incident.createdAt).toLocaleString()}
                </p>
                <div className="action-row" style={{ marginTop: 12 }}>
                  <Link href={`/admin/evidence?incidentId=${encodeURIComponent(incident.id)}`}>Open linked evidence</Link>
                  {incident.pollingUnitId ? (
                    <Link href={`/admin/evidence?pollingUnitId=${encodeURIComponent(incident.pollingUnitId)}`}>
                      Open PU dossier
                    </Link>
                  ) : null}
                </div>
                {incident.governance?.flags.length ? (
                  <div className="reward-list" style={{ marginTop: 12 }}>
                    {incident.governance.flags.map((flag) => (
                      <article key={`${incident.id}-${flag.code}`} className="reward-item">
                        <strong>{flag.code}</strong>
                        <p>{flag.message}</p>
                        <p className="muted">{flag.severity}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No governance flags on this incident.</p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
