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
      <main className="shell">
        <section className="panel hero">
          <h1>Loading admin overview...</h1>
          <p>Please wait while your scoped workspace is prepared.</p>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load dashboard</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/login">Return to admin login</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">{getScopeTitle(data.user)}</p>
        <h1>{data.user.name}</h1>
        <p>Current territory scope: {territoryLabel}</p>
        <p className="muted">
          The overview shows only operational signals and next actions. Management, territory filtering, and account workflows now live on dedicated pages.
        </p>
        <div className="action-row" style={{ marginTop: 12 }}>
          <button className="button secondary" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
      </section>

      <AdminNav role={data?.user.role} />

      <section className="grid stats">
        <article className="panel card">
          <h2>Agents in Scope</h2>
          <div className="value">{data.summary.totalAgentsInScope}</div>
        </article>
        <article className="panel card">
          <h2>Voters in Scope</h2>
          <div className="value">{data.summary.totalVotersInScope}</div>
        </article>
        <article className="panel card">
          <h2>Open Incidents</h2>
          <div className="value">{data.summary.totalIncidentsOpen}</div>
        </article>
        <article className="panel card">
          <h2>Critical Incidents</h2>
          <div className="value">{data.summary.totalIncidentsCritical}</div>
        </article>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        <section className="panel card">
          <h2>Territory Coverage</h2>
          {data.coverage.scopeWarning ? <p className="muted">{data.coverage.scopeWarning}</p> : null}
          <div className="reward-list">
            <article className="reward-item">
              <strong>States in scope</strong>
              <p>{data.coverage.totalStatesInScope}</p>
            </article>
            <article className="reward-item">
              <strong>LGAs in scope</strong>
              <p>{data.coverage.totalLgasInScope}</p>
            </article>
            <article className="reward-item">
              <strong>Wards in scope</strong>
              <p>{data.coverage.totalWardsInScope}</p>
            </article>
            <article className="reward-item">
              <strong>Polling units in scope</strong>
              <p>{data.coverage.totalPollingUnitsInScope}</p>
            </article>
            <article className="reward-item">
              <strong>Assigned agents</strong>
              <p>{data.coverage.pollingUnitsWithAssignedAgents}</p>
            </article>
            <article className="reward-item">
              <strong>Recent activity</strong>
              <p>{data.coverage.pollingUnitsWithRecentActivity}</p>
            </article>
            <article className="reward-item">
              <strong>Units without recent activity</strong>
              <p>{data.coverage.pollingUnitsWithoutActivity}</p>
            </article>
          </div>
        </section>

        <section className="panel card">
          <h2>Management Workflow</h2>
          <div className="reward-list">
            <article className="reward-item">
              <strong>Start with management</strong>
              <p>Open the management workspace first to keep user, territory, and creation actions inside one controlled workflow.</p>
              <Link href="/admin/manage">Open management hub</Link>
            </article>
            <article className="reward-item">
              <strong>Select territory in workflow</strong>
              <p>Choose state, LGA, and ward scope from the management flow before reviewing users or creating new accounts.</p>
              <Link href="/admin/manage/territory">Open territory selector</Link>
            </article>
            <article className="reward-item">
              <strong>Manage users</strong>
              <p>Review scoped user lists, edit assignments, and control activation after narrowing the territory you are working in.</p>
              <Link href="/admin/manage/users">Open user management</Link>
            </article>
            <article className="reward-item">
              <strong>Create users</strong>
              <p>Move from territory selection into role-aware creation for admins, candidates, and agents without leaving the management path.</p>
              <Link href="/admin/manage/create">Open create workflow</Link>
            </article>
          </div>
        </section>

        <section className="panel card">
          <h2>Monitoring Workflow</h2>
          <div className="reward-list">
            <article className="reward-item">
              <strong>Live operations</strong>
              <p>Monitor visible agents, map activity, and field movement inside your authorized territory.</p>
              <Link href="/admin/operations/live">Open live ops</Link>
            </article>
            <article className="reward-item">
              <strong>Coverage intelligence</strong>
              <p>Identify weak wards, polling units without agents, and areas with missing recent field signals.</p>
              <Link href="/admin/operations/coverage">Open coverage</Link>
            </article>
            <article className="reward-item">
              <strong>Incidents and election reports</strong>
              <p>Review flagged incidents, escalation state, and election-day reports as part of the same monitoring surface.</p>
              <div className="action-row" style={{ marginTop: 12 }}>
                <Link href="/admin/incidents">Open incidents</Link>
                <Link href="/admin/election-reports">Open election reports</Link>
              </div>
            </article>
            <article className="reward-item">
              <strong>Send communications</strong>
              <p>Preview recipient counts and send scoped broadcasts by role, territory, party, and workflow filter.</p>
              <Link href="/admin/communications">Open communications</Link>
            </article>
          </div>
        </section>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <section className="panel card">
          <h2>Recent Field Activity</h2>
          {data.agentActivity.length === 0 ? (
            <p className="muted">No recent agent activity is visible in this territory.</p>
          ) : (
            <div className="reward-list">
              {data.agentActivity.slice(0, 5).map((item) => (
                <article key={item.agentUserId} className="reward-item">
                  <strong>{item.name}</strong>
                  <p>{item.latestActivityType || "No recent activity"}</p>
                  <p className="muted">{item.latestActivityAt ? new Date(item.latestActivityAt).toLocaleString() : "No timestamp"}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel card">
          <h2>Notifications</h2>
          {data.notifications.length === 0 ? (
            <p className="muted">No notifications yet.</p>
          ) : (
            <div className="reward-list">
              {data.notifications.slice(0, 5).map((item) => (
                <article key={item.id} className="reward-item">
                  <strong>{item.title}</strong>
                  <p>{item.message}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel card">
          <h2>Redemption Queue</h2>
          {data.redemptions.length === 0 ? (
            <p className="muted">No redemption requests are waiting in this scope.</p>
          ) : (
            <div className="reward-list">
              {data.redemptions.slice(0, 5).map((item) => (
                <article key={item.id} className="reward-item">
                  <strong>{item.status}</strong>
                  <p>{item.pointsRequested} points requested</p>
                  <p className="muted">{new Date(item.createdAt).toLocaleString()}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
