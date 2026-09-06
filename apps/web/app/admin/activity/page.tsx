"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AuditLogItem, AuthUserProfile } from "@pics-nigeria/shared";
import { ApiError, fetchAuditLogs, fetchCurrentUser } from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { describeTerritory } from "../../../components/admin-management-utils";
import { FeedbackBanner } from "../../../components/feedback-banner";
import {
  DataTable,
  EmptyRow,
  PageHead,
  Panel,
  StateView,
  Toolbar,
  ToolbarEnd,
  ToolbarField,
  formatCount,
} from "../../../components/ui";
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
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
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
      <main className="console-shell">
        <PageHead title="Activity history" />
        <StateView kind="loading" title="Loading activity history…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Activity history" />
        <StateView
          kind="error"
          title="Unable to load activity history"
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
        title="Activity history"
        lead={`Audit trail · Visible scope: ${describeTerritory(
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
        <FeedbackBanner tone="error" message={error} />

        <Panel
          title="Recent activity"
          meta={`${formatCount(visibleLogs.length)} visible`}
          flush
        >
          <Toolbar>
            <ToolbarField label="Action">
              <select value={action} onChange={(event) => setAction(event.target.value)}>
                {actionOptions.map((item) => (
                  <option key={item || "all"} value={item}>
                    {item ? item.replace(/_/g, " ").toLowerCase() : "All visible actions"}
                  </option>
                ))}
              </select>
            </ToolbarField>
            <ToolbarField label="Target type">
              <select value={targetType} onChange={(event) => setTargetType(event.target.value)}>
                {targetTypeOptions.map((item) => (
                  <option key={item || "all"} value={item}>
                    {item ? item.replace(/_/g, " ").toLowerCase() : "All target types"}
                  </option>
                ))}
              </select>
            </ToolbarField>
            <ToolbarField label="From">
              <input type="datetime-local" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </ToolbarField>
            <ToolbarField label="To">
              <input type="datetime-local" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </ToolbarField>
            <ToolbarEnd>
              <button className="btn btn-sm btn-primary" type="button" onClick={() => void handleApplyFilters()} disabled={loading}>
                {loading ? "Loading…" : "Apply"}
              </button>
            </ToolbarEnd>
          </Toolbar>

          <div className="panel-body">
            <p className="muted-text">This view is backend-filtered by your current permission and territory scope.</p>
          </div>

          <DataTable
            head={
              <tr>
                <th>Action</th>
                <th>Target</th>
                <th>Actor</th>
                <th>When</th>
                <th className="actions">Detail</th>
              </tr>
            }
          >
            {visibleLogs.length === 0 ? (
              <EmptyRow colSpan={5}>No activity history is visible for this filter.</EmptyRow>
            ) : (
              visibleLogs.flatMap((item) => {
                const open = expandedLogId === item.id;
                const rows = [
                  <tr key={item.id} className={open ? "row-open" : undefined}>
                    <td>
                      <strong>{item.action.replace(/_/g, " ").toLowerCase()}</strong>
                    </td>
                    <td className="muted-text">
                      {item.targetType.replace(/_/g, " ").toLowerCase()}
                      <div className="mono">{item.targetId}</div>
                    </td>
                    <td>{item.actorName}</td>
                    <td className="muted-text">{new Date(item.createdAt).toLocaleString()}</td>
                    <td className="actions">
                      {item.metadata ? (
                        <button
                          className="btn btn-sm"
                          type="button"
                          aria-expanded={open}
                          onClick={() => setExpandedLogId(open ? null : item.id)}
                        >
                          {open ? "Hide" : "Metadata"}
                        </button>
                      ) : (
                        <span className="muted-text">—</span>
                      )}
                    </td>
                  </tr>,
                ];

                if (open && item.metadata) {
                  rows.push(
                    <tr key={`${item.id}-meta`} className="row-editor">
                      <td colSpan={5}>
                        <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                          {JSON.stringify(item.metadata, null, 2)}
                        </pre>
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
    </main>
  );
}
