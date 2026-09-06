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
import {
  DataTable,
  EmptyRow,
  Kpi,
  KpiRow,
  Notice,
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
      <main className="console-shell">
        <PageHead title="Incident review" />
        <StateView kind="loading" title="Loading incident review…" />
      </main>
    );
  }

  if (!user || !governance) {
    return (
      <main className="console-shell">
        <PageHead title="Incident review" />
        <StateView
          kind="error"
          title="Unable to load incident review"
          detail={error || "Authentication is required."}
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
        title="Incident review queue"
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
        {error ? <Notice tone="error" title="Something went wrong">{error}</Notice> : null}

        <KpiRow>
          <Kpi label="Total incidents" value={formatCount(governance.totalIncidents)} />
          <Kpi
            label="Flagged"
            value={formatCount(governance.flaggedIncidents)}
            note="Carry at least one advisory signal"
            tone={governance.flaggedIncidents > 0 ? "accent" : undefined}
          />
          <Kpi
            label="Critical review"
            value={formatCount(governance.criticalReviewIncidents)}
            tone={governance.criticalReviewIncidents > 0 ? "warn" : undefined}
          />
          <Kpi
            label="Escalated"
            value={formatCount(governance.escalatedIncidents)}
            tone={governance.escalatedIncidents > 0 ? "warn" : undefined}
          />
        </KpiRow>

        <Panel
          title="Review signals"
          meta={`${formatCount(incidents.length)} visible`}
          flush
        >
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
            <ToolbarField label="Type">
              <select value={incidentType} onChange={(event) => setIncidentType(event.target.value)}>
                <option value="">All types</option>
                {INCIDENT_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </select>
            </ToolbarField>
            <ToolbarField label="Review priority">
              <select value={reviewPriority} onChange={(event) => setReviewPriority(event.target.value)}>
                {reviewPriorityOptions.map((option) => (
                  <option key={option || "all"} value={option}>
                    {option ? option.toLowerCase() : "All priorities"}
                  </option>
                ))}
              </select>
            </ToolbarField>
            <label>
              <input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} />
              <span>Flagged only</span>
            </label>
            <ToolbarEnd>
              <button className="btn btn-sm btn-primary" type="button" onClick={() => void handleApplyFilters()} disabled={loading}>
                {loading ? "Loading…" : "Apply"}
              </button>
            </ToolbarEnd>
          </Toolbar>

          <div className="panel-body stack-2">
            <p className="muted-text">
              Signals are advisory. They surface potential duplicate, territory mismatch, assignment and evidence gaps
              without blocking submissions.
            </p>
            {topFlags.length ? (
              <div className="cluster">
                {topFlags.map(([code, count]) => (
                  <span key={code} className="pill pill-stale">
                    {code}: {count}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <DataTable
            head={
              <tr>
                <th>Incident</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Review</th>
                <th>Signals</th>
                <th>Reported</th>
                <th className="actions">Links</th>
              </tr>
            }
          >
            {incidents.length === 0 ? (
              <EmptyRow colSpan={7}>No incidents match the current review filter.</EmptyRow>
            ) : (
              incidents.map((incident) => (
                <tr key={incident.id}>
                  <td>
                    <strong>{incident.title}</strong>
                    <div className="muted-text">{incident.type.replace(/_/g, " ").toLowerCase()}</div>
                  </td>
                  <td className="muted-text">{incident.severity.replace(/_/g, " ").toLowerCase()}</td>
                  <td>
                    <StatusPill status={incident.status} />
                  </td>
                  <td className="muted-text">
                    {(incident.governance?.reviewPriority || "ROUTINE").toLowerCase()}
                    <div>{(incident.governance?.escalationStatus || "NOT_ESCALATED").replace(/_/g, " ").toLowerCase()}</div>
                  </td>
                  <td>
                    {incident.governance?.flags.length ? (
                      <span className="cluster">
                        {incident.governance.flags.map((flag) => (
                          <span
                            key={`${incident.id}-${flag.code}`}
                            className={
                              flag.severity === "HIGH"
                                ? "pill pill-error"
                                : flag.severity === "WARNING"
                                  ? "pill pill-pending"
                                  : "pill pill-stale"
                            }
                            title={flag.message}
                          >
                            {flag.code.replace(/_/g, " ").toLowerCase()}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="muted-text">None</span>
                    )}
                  </td>
                  <td className="muted-text">
                    {new Date(incident.createdAt).toLocaleString()}
                    <div>{incident.governance?.reporterRole || "Unknown reporter"}</div>
                  </td>
                  <td className="actions">
                    <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                      <Link className="btn btn-sm" href={`/admin/evidence?incidentId=${encodeURIComponent(incident.id)}`}>
                        Evidence
                      </Link>
                      {incident.pollingUnitId ? (
                        <Link
                          className="btn btn-sm"
                          href={`/admin/evidence?pollingUnitId=${encodeURIComponent(incident.pollingUnitId)}`}
                        >
                          PU dossier
                        </Link>
                      ) : null}
                    </span>
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
