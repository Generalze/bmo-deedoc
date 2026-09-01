"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AuditLogItem, AuthUserProfile } from "@pics-nigeria/shared";
import { ApiError, fetchAuditLogs, fetchCurrentUser } from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { describeTerritory } from "../../../components/admin-management-utils";
import { FeedbackBanner } from "../../../components/feedback-banner";
import { readSession } from "../../../lib/session";

const actionOptions = [
  "",
  "ADMIN_CREATED",
  "CANDIDATE_CREATED",
  "AGENT_CREATED",
  "ADMIN_UPDATED",
  "CANDIDATE_UPDATED",
  "AGENT_UPDATED",
  "USER_DEACTIVATED",
  "USER_REACTIVATED",
  "USER_DELETED",
  "FIELD_TASK_CREATED",
  "FIELD_TASK_UPDATED",
  "VOTER_ENGAGEMENT_TASK_CREATED",
  "INCIDENT_STATUS_UPDATED",
  "INCIDENT_ASSIGNED",
  "INCIDENT_ESCALATED",
  "ELECTION_DAY_REPORT_SUBMITTED",
  "ELECTION_DAY_REPORT_STATUS_UPDATED",
  "BROADCAST_CREATED",
  "REWARD_REDEMPTION_APPROVED",
  "REWARD_REDEMPTION_REJECTED",
  "REWARD_REDEMPTION_PAID",
  "STATE_AGENT_TARGET_UPDATED",
] as const;

const targetTypeOptions = [
  "",
  "User",
  "FieldTask",
  "VoterEngagementTask",
  "Incident",
  "RewardRedemption",
  "BroadcastMessage",
  "Poll",
  "ElectionDayReport",
  "State",
] as const;

function parseMetadata(metadataJson: string | null) {
  if (!metadataJson) {
    return null;
  }

  try {
    return JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toIsoDateTime(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

export default function AdminActivityPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadPage(token: string, nextAction?: string, nextTargetType?: string, nextDateFrom?: string, nextDateTo?: string) {
    const [currentUser, logs] = await Promise.all([
      fetchCurrentUser(token),
      fetchAuditLogs(token, {
        action: nextAction || undefined,
        targetType: nextTargetType || undefined,
        dateFrom: toIsoDateTime(nextDateFrom || ""),
        dateTo: toIsoDateTime(nextDateTo || ""),
      }),
    ]);

    if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
      throw new ApiError("This page is available to admins only.", 403);
    }

    setUser(currentUser);
    setAuditLogs(logs);
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    loadPage(token)
      .catch((caughtError) => setError(caughtError instanceof Error ? caughtError.message : "Could not load activity history."))
      .finally(() => setLoading(false));
  }, []);

  const visibleLogs = useMemo(() => {
    return auditLogs.map((item) => ({
      ...item,
      metadata: parseMetadata(item.metadataJson),
    }));
  }, [auditLogs]);

  async function handleApplyFilters() {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      await loadPage(token, action, targetType, dateFrom, dateTo);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not filter activity history.");
    } finally {
      setLoading(false);
    }
  }

  if (loading && !user) {
    return (
      <main className="shell">
        <section className="panel hero">
          <h1>Loading activity history...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load activity history</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/admin/dashboard">Return to admin overview</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Audit trail</p>
        <h1>Activity history</h1>
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
      <FeedbackBanner tone="error" message={error} />

      <section className="panel card">
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label className="field">
            <span>Action</span>
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              {actionOptions.map((item) => (
                <option key={item || "all"} value={item}>
                  {item || "All visible actions"}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Target type</span>
            <select value={targetType} onChange={(event) => setTargetType(event.target.value)}>
              {targetTypeOptions.map((item) => (
                <option key={item || "all"} value={item}>
                  {item || "All visible target types"}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Date from</span>
            <input type="datetime-local" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </label>
          <label className="field">
            <span>Date to</span>
            <input type="datetime-local" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
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
            <h2>Recent activity</h2>
            <p className="muted">This view is backend-filtered by your current permission and territory scope.</p>
          </div>
          <span className="status-pill">{visibleLogs.length} visible</span>
        </div>

        {visibleLogs.length === 0 ? (
          <p className="muted">No activity history is currently visible for this filter.</p>
        ) : (
          <div className="reward-list">
            {visibleLogs.map((item) => (
              <article key={item.id} className="reward-item">
                <strong>{item.action}</strong>
                <p>{item.targetType} | {item.targetId}</p>
                <p className="muted">Actor: {item.actorName}</p>
                <p className="muted">{new Date(item.createdAt).toLocaleString()}</p>
                {item.metadata ? (
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem", margin: 0 }}>
                    {JSON.stringify(item.metadata, null, 2)}
                  </pre>
                ) : (
                  <p className="muted">No additional metadata.</p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
