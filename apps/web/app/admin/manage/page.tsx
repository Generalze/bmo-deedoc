"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { emptyTerritorySummary } from "@pics-nigeria/shared";
import type { AuthUserProfile, ManagedUserItem } from "@pics-nigeria/shared";
import { ApiError, fetchCurrentUser, fetchManagedUsers } from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { describeTerritory, getScopeTitle } from "../../../components/admin-management-utils";
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
      <main className="shell">
        <section className="panel hero">
          <h1>Loading management workspace...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load management workspace</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/login">Return to admin login</Link>
        </section>
      </main>
    );
  }

  const adminCount = managedUsers.filter((item) => item.role === "ADMIN").length;
  const candidateCount = managedUsers.filter((item) => item.role === "CANDIDATE").length;
  const agentCount = managedUsers.filter((item) => item.role === "AGENT").length;
  const voterCount = managedUsers.filter((item) => item.role === "VOTER").length;

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">{getScopeTitle(user)}</p>
        <h1>Management workspace</h1>
        <p>Authority is scoped to {describeTerritory(user.adminProfile || emptyTerritorySummary())}. Choose a territory first, then move into focused user workflows.</p>
      </section>

      <AdminNav role={user?.role} />

      <section className="grid stats">
        <article className="panel card">
          <h2>Admins</h2>
          <div className="value">{adminCount}</div>
        </article>
        <article className="panel card">
          <h2>Candidates</h2>
          <div className="value">{candidateCount}</div>
        </article>
        <article className="panel card">
          <h2>Agents</h2>
          <div className="value">{agentCount}</div>
        </article>
        <article className="panel card">
          <h2>Supporters</h2>
          <div className="value">{voterCount}</div>
        </article>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <section className="panel card">
          <h2>Select Territory</h2>
          <p className="muted">Start every management workflow by narrowing to the territory you control.</p>
          <Link href="/admin/manage/territory">Open territory selector</Link>
        </section>
        <section className="panel card">
          <h2>Manage Users</h2>
          <p className="muted">Review scoped user lists, open edit workflows, link party assignments, and control activation safely.</p>
          <Link href="/admin/manage/users">Open user management</Link>
        </section>
        <section className="panel card">
          <h2>Create User</h2>
          <p className="muted">Start with territory and role, then create a new admin, candidate, or agent with the right party relationship.</p>
          <Link href="/admin/manage/create">Open create workflow</Link>
        </section>
        <section className="panel card">
          <h2>Reference Structures</h2>
          <p className="muted">Super-admin-only zone and party maintenance stays outside day-to-day user operations.</p>
          <Link href="/admin/reference">Open reference data</Link>
        </section>
      </section>
    </main>
  );
}
