"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { emptyTerritorySummary } from "@pics-nigeria/shared";
import type { AuthUserProfile, ManagedUserItem } from "@pics-nigeria/shared";
import { ApiError, fetchCurrentUser, fetchManagedUsers } from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { describeTerritory, getScopeTitle } from "../../../components/admin-management-utils";
import { Kpi, KpiRow, PageHead, Panel, PanelGrid, StateView, formatCount } from "../../../components/ui";
import { clearSession, readSession } from "../../../lib/session";

export default function AdminManagePage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [managedUsers, setManagedUsers] = useState<ManagedUserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    Promise.all([fetchCurrentUser(token), fetchManagedUsers(token, { limit: 100 })])
      .then(([currentUser, users]) => {
        if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
          throw new ApiError("This page is available to admins only.", 403);
        }

        setUser(currentUser);
        setManagedUsers(users);
      })
      .catch((caughtError) => {
        // Only a real authentication failure clears the session. A 403 means this
        // screen is above the operator's role, not that they are signed out.
        if (caughtError instanceof ApiError && caughtError.status === 401) {
          clearSession();
        }
        setError(caughtError instanceof Error ? caughtError.message : "Could not load management overview.");
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Management workspace" />
        <StateView kind="loading" title="Loading management workspace…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Management workspace" />
        <StateView
          kind="error"
          title="Unable to load management workspace"
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

  const adminCount = managedUsers.filter((item) => item.role === "ADMIN").length;
  const candidateCount = managedUsers.filter((item) => item.role === "CANDIDATE").length;
  const agentCount = managedUsers.filter((item) => item.role === "AGENT").length;
  const voterCount = managedUsers.filter((item) => item.role === "VOTER").length;

  return (
    <main className="console-shell">
      <PageHead
        title="Management workspace"
        lead={`${getScopeTitle(user)} · Authority is scoped to ${describeTerritory(
          user.adminProfile || emptyTerritorySummary(),
        )}. Choose a territory first, then move into a focused user workflow.`}
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        <KpiRow>
          <Kpi label="Admins" value={formatCount(adminCount)} />
          <Kpi label="Candidates" value={formatCount(candidateCount)} />
          <Kpi label="Agents" value={formatCount(agentCount)} />
          <Kpi label="Supporters" value={formatCount(voterCount)} />
        </KpiRow>

        <PanelGrid>
          <Panel
            title="Select territory"
            actions={
              <Link className="btn btn-sm btn-primary" href="/admin/manage/territory">
                Open
              </Link>
            }
          >
            <p className="muted-text">Start every management workflow by narrowing to the territory you control.</p>
          </Panel>

          <Panel
            title="Manage users"
            actions={
              <Link className="btn btn-sm" href="/admin/manage/users">
                Open
              </Link>
            }
          >
            <p className="muted-text">
              Review scoped user lists, open edit workflows, link party assignments and control activation safely.
            </p>
          </Panel>

          <Panel
            title="Create user"
            actions={
              <Link className="btn btn-sm" href="/admin/manage/create">
                Open
              </Link>
            }
          >
            <p className="muted-text">
              Start with territory and role, then create an admin, candidate or agent with the right party
              relationship.
            </p>
          </Panel>

          <Panel
            title="Reference structures"
            actions={
              <Link className="btn btn-sm" href="/admin/reference">
                Open
              </Link>
            }
          >
            <p className="muted-text">
              Super-admin-only zone and party maintenance, kept outside day-to-day user operations.
            </p>
          </Panel>
        </PanelGrid>
      </div>
    </main>
  );
}
