"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type {
  AdminDashboardSummary,
  AgentActivitySummary,
  AuthUserProfile,
  NotificationItem,
  PollingUnitCoverageSummary,
  RewardRedemptionItem,
} from "@pics-nigeria/shared";
import { emptyTerritorySummary } from "@pics-nigeria/shared";
import {
  ApiError,
  fetchAdminAgentActivitySummaries,
  fetchAdminPollingUnitCoverage,
  fetchAdminRedemptions,
  fetchAdminSummary,
  fetchCurrentUser,
  fetchNotifications,
  logoutCurrentUser,
} from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import {
  DataTable,
  DetailList,
  EmptyRow,
  Kpi,
  KpiRow,
  PageHead,
  Panel,
  PanelGrid,
  StateView,
  StatusPill,
  formatCount,
} from "../../../components/ui";
import { describeTerritory, getScopeTitle } from "../../../components/admin-management-utils";
import { clearSession, readSession } from "../../../lib/session";

type DashboardData = {
  user: AuthUserProfile;
  summary: AdminDashboardSummary;
  coverage: PollingUnitCoverageSummary;
  notifications: NotificationItem[];
  redemptions: RewardRedemptionItem[];
  agentActivity: AgentActivitySummary[];
};

async function loadDashboard(token: string): Promise<DashboardData> {
  const [user, summary, coverage, notifications, redemptions, agentActivity] = await Promise.all([
    fetchCurrentUser(token),
    fetchAdminSummary(token),
    fetchAdminPollingUnitCoverage(token),
    fetchNotifications(token),
    fetchAdminRedemptions(token),
    fetchAdminAgentActivitySummaries(token),
  ]);

  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") {
    throw new ApiError("This dashboard is available to admins only.", 403);
  }

  return { user, summary, coverage, notifications, redemptions, agentActivity };
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function handleLogout() {
    const token = readSession();
    if (token) {
      try {
        await logoutCurrentUser(token);
      } catch {
        // Best effort.
      }
    }

    clearSession();
    window.location.href = "/login";
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    loadDashboard(token)
      .then(setData)
      .catch((caughtError) => {
        // Only a real authentication failure clears the session. A 403 means this
        // screen is above the operator's role, not that they are signed out.
        if (caughtError instanceof ApiError && caughtError.status === 401) {
          clearSession();
        }
        setError(caughtError instanceof Error ? caughtError.message : "Could not load the admin dashboard.");
      })
      .finally(() => setLoading(false));
  }, []);

  const territoryLabel = useMemo(
    () => describeTerritory(data?.user.adminProfile || emptyTerritorySummary()),
    [data?.user.adminProfile],
  );

  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Admin overview" />
        <StateView kind="loading" title="Preparing your scoped workspace…" />
      </main>
    );
  }

  if (!data) {
    return (
      <main className="console-shell">
        <PageHead title="Admin overview" />
        <StateView
          kind="error"
          title="Unable to load the overview"
          detail={error || "Authentication is required."}
          action={
            <Link className="btn btn-primary" href="/login">
              Return to sign in
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <main className="console-shell">
      <PageHead
        title={data.user.name}
        lead={`${getScopeTitle(data.user)} · ${territoryLabel}`}
        actions={
          <button className="btn" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        }
      />

      <AdminNav role={data?.user.role} />

      <div className="stack-4">
        <KpiRow>
          <Kpi label="Agents in scope" value={formatCount(data.summary.totalAgentsInScope)} />
          <Kpi label="Voters in scope" value={formatCount(data.summary.totalVotersInScope)} />
          <Kpi
            label="Open incidents"
            value={formatCount(data.summary.totalIncidentsOpen)}
            tone={data.summary.totalIncidentsOpen > 0 ? "accent" : undefined}
          />
          <Kpi
            label="Critical incidents"
            value={formatCount(data.summary.totalIncidentsCritical)}
            note={data.summary.totalIncidentsCritical > 0 ? "Needs attention now" : "None open"}
            tone={data.summary.totalIncidentsCritical > 0 ? "warn" : undefined}
          />
          <Kpi
            label="Units without recent activity"
            value={formatCount(data.coverage.pollingUnitsWithoutActivity)}
            note="Polling Units with no field signal"
            tone={data.coverage.pollingUnitsWithoutActivity > 0 ? "warn" : undefined}
          />
        </KpiRow>

        <PanelGrid wide>
          <Panel title="Territory coverage" meta={data.coverage.scopeWarning || undefined}>
            <DetailList
              rows={[
                { label: "States", value: formatCount(data.coverage.totalStatesInScope) },
                { label: "LGAs", value: formatCount(data.coverage.totalLgasInScope) },
                { label: "Wards", value: formatCount(data.coverage.totalWardsInScope) },
                { label: "Polling Units", value: formatCount(data.coverage.totalPollingUnitsInScope) },
                { label: "With assigned agents", value: formatCount(data.coverage.pollingUnitsWithAssignedAgents) },
                { label: "With recent activity", value: formatCount(data.coverage.pollingUnitsWithRecentActivity) },
                {
                  label: "Without activity",
                  value: formatCount(data.coverage.pollingUnitsWithoutActivity),
                },
              ]}
            />
          </Panel>

          {/*
            These were two panels of eight link cards, each with a paragraph of
            prose explaining a destination that AdminNav already lists directly
            above. Every destination is kept; the duplicated explanation is not.
          */}
          <Panel title="Jump to">
            <div className="stack-3">
              <div>
                <span className="kpi-label">Management</span>
                <div className="btn-row">
                  <Link className="btn btn-sm" href="/admin/manage">
                    Management hub
                  </Link>
                  <Link className="btn btn-sm" href="/admin/manage/territory">
                    Territory selector
                  </Link>
                  <Link className="btn btn-sm" href="/admin/manage/users">
                    User management
                  </Link>
                  <Link className="btn btn-sm" href="/admin/manage/create">
                    Create users
                  </Link>
                </div>
              </div>
              <div>
                <span className="kpi-label">Monitoring</span>
                <div className="btn-row">
                  <Link className="btn btn-sm" href="/admin/operations/live">
                    Live operations
                  </Link>
                  <Link className="btn btn-sm" href="/admin/operations/coverage">
                    Coverage
                  </Link>
                  <Link className="btn btn-sm" href="/admin/incidents">
                    Incidents
                  </Link>
                  <Link className="btn btn-sm" href="/admin/election-reports">
                    Election reports
                  </Link>
                  <Link className="btn btn-sm" href="/admin/communications">
                    Communications
                  </Link>
                </div>
              </div>
            </div>
          </Panel>
        </PanelGrid>

        <PanelGrid>
          <Panel title="Recent field activity" flush>
            <DataTable
              head={
                <tr>
                  <th>Agent</th>
                  <th>Latest activity</th>
                  <th>When</th>
                </tr>
              }
            >
              {data.agentActivity.length === 0 ? (
                <EmptyRow colSpan={3}>No recent agent activity in this territory.</EmptyRow>
              ) : (
                data.agentActivity.slice(0, 8).map((item) => (
                  <tr key={item.agentUserId}>
                    <td>{item.name}</td>
                    <td className="muted-text">{item.latestActivityType || "No recent activity"}</td>
                    <td className="muted-text">
                      {item.latestActivityAt ? new Date(item.latestActivityAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>

          <Panel title="Redemption queue" flush>
            <DataTable
              head={
                <tr>
                  <th>Status</th>
                  <th className="numeric">Points requested</th>
                  <th>Requested</th>
                </tr>
              }
            >
              {data.redemptions.length === 0 ? (
                <EmptyRow colSpan={3}>No redemption requests waiting in this scope.</EmptyRow>
              ) : (
                data.redemptions.slice(0, 8).map((item) => (
                  <tr key={item.id}>
                    <td>
                      <StatusPill status={item.status} />
                    </td>
                    <td className="numeric">{formatCount(item.pointsRequested)}</td>
                    <td className="muted-text">{new Date(item.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>

          <Panel title="Notifications">
            {data.notifications.length === 0 ? (
              <StateView kind="empty" title="No notifications yet" />
            ) : (
              <ul className="stack-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {data.notifications.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    <p className="muted-text">{item.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </PanelGrid>
      </div>
    </main>
  );
}
