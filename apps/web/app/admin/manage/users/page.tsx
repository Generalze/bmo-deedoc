"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { emptyTerritorySummary } from "@pics-nigeria/shared";
import type { AuthUserProfile, ManagedUserItem } from "@pics-nigeria/shared";
import {
  ApiError,
  deleteManagedUser,
  fetchCurrentUser,
  fetchManagedUsers,
  revokeAgentSession,
  setUserActivation,
} from "../../../../lib/api";
import { AdminNav } from "../../../../components/admin-nav";
import { ConfirmDialog } from "../../../../components/confirm-dialog";
import { FeedbackBanner } from "../../../../components/feedback-banner";
import {
  describeTerritory,
  getManagedRoleLabel,
} from "../../../../components/admin-management-utils";
import {
  DataTable,
  EmptyRow,
  Kpi,
  KpiRow,
  PageHead,
  Panel,
  StateView,
  formatCount,
} from "../../../../components/ui";
import { clearSession, readSession } from "../../../../lib/session";

export default function AdminManageUsersPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [managedUsers, setManagedUsers] = useState<ManagedUserItem[]>([]);
  const [locator, setLocator] = useState({
    stateId: "",
    lgaId: "",
    wardId: "",
    role: "",
    search: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmState, setConfirmState] = useState<
    | null
    | {
        kind: "toggle" | "delete" | "revoke-session";
        item: ManagedUserItem;
        nextIsActive?: boolean;
      }
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  async function loadPage(token: string, nextLocator: { stateId: string; lgaId: string; wardId: string; role: string; search: string }) {
    const [currentUser, users] = await Promise.all([
      fetchCurrentUser(token),
      nextLocator.role
        ? fetchManagedUsers(token, {
            role: nextLocator.role as "ADMIN" | "CANDIDATE" | "AGENT" | "VOTER",
            stateId: nextLocator.stateId || undefined,
            lgaId: nextLocator.lgaId || undefined,
            wardId: nextLocator.wardId || undefined,
            search: nextLocator.search || undefined,
            limit: 100,
          })
        : Promise.resolve([]),
    ]);

    if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
      throw new ApiError("This page is available to admins only.", 403);
    }

    setUser(currentUser);
    setManagedUsers(users);
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const nextLocator = {
      stateId: params.get("stateId") || "",
      lgaId: params.get("lgaId") || "",
      wardId: params.get("wardId") || "",
      role: params.get("role") || "",
      search: params.get("search") || "",
    };
    setLocator(nextLocator);

    loadPage(token, nextLocator)
      .catch((caughtError) => {
        // Only a real authentication failure clears the session. A 403 means this
        // screen is above the operator's role, not that they are signed out.
        if (caughtError instanceof ApiError && caughtError.status === 401) {
          clearSession();
        }
        setError(caughtError instanceof Error ? caughtError.message : "Could not load scoped users.");
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleToggleUser(userId: string, nextIsActive: boolean) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      setMessage("");
      const result = await setUserActivation(token, userId, nextIsActive);
      setMessage(result.message);
      await loadPage(token, locator);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not update account status.");
    }
  }

  async function handleDeleteUser(item: ManagedUserItem) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      setMessage("");
      const result = await deleteManagedUser(token, item.userId);
      setMessage(result.message);
      await loadPage(token, locator);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not delete the account.");
    }
  }

  async function handleRevokeAgentSession(item: ManagedUserItem) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      setMessage("");
      const result = await revokeAgentSession(token, item.userId);
      setMessage(result.message);
      await loadPage(token, locator);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not revoke the agent session.");
    }
  }

  async function handleConfirmAction() {
    if (!confirmState) {
      return;
    }

    setConfirmBusy(true);
    try {
      if (confirmState.kind === "toggle" && typeof confirmState.nextIsActive === "boolean") {
        await handleToggleUser(confirmState.item.userId, confirmState.nextIsActive);
      } else if (confirmState.kind === "delete") {
        await handleDeleteUser(confirmState.item);
      } else if (confirmState.kind === "revoke-session") {
        await handleRevokeAgentSession(confirmState.item);
      }
      setConfirmState(null);
    } finally {
      setConfirmBusy(false);
    }
  }
  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Manage users" />
        <StateView kind="loading" title="Loading user management…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Manage users" />
        <StateView
          kind="error"
          title="Unable to load users"
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
        title="Manage users"
        lead={`Visible scope: ${describeTerritory(user.adminProfile || emptyTerritorySummary())}`}
        actions={
          <>
            <Link className="btn" href="/admin/manage/territory">
              Open locator
            </Link>
            {locator.role !== "VOTER" ? (
              <Link
                className="btn btn-primary"
                href={
                  locator.role
                    ? `/admin/manage/create?role=${encodeURIComponent(locator.role)}&stateId=${encodeURIComponent(locator.stateId)}&lgaId=${encodeURIComponent(locator.lgaId)}&wardId=${encodeURIComponent(locator.wardId)}`
                    : "/admin/manage/create"
                }
              >
                Create user
              </Link>
            ) : null}
          </>
        }
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        <FeedbackBanner tone="error" message={error} />
        <FeedbackBanner tone="success" message={message} />

        <KpiRow>
          <Kpi label="Total in view" value={formatCount(managedUsers.length)} />
          <Kpi label="Active" value={formatCount(managedUsers.filter((item) => item.isActive).length)} />
          <Kpi
            label="Inactive"
            value={formatCount(managedUsers.filter((item) => !item.isActive).length)}
            tone={managedUsers.some((item) => !item.isActive) ? "warn" : undefined}
          />
        </KpiRow>

        <Panel
          title="User list"
          meta={
            locator.role
              ? `${getManagedRoleLabel(locator.role)} in ${describeTerritory({
                  ...emptyTerritorySummary(),
                  stateId: locator.stateId || null,
                  lgaId: locator.lgaId || null,
                  wardId: locator.wardId || null,
                })}`
              : "No role selected"
          }
          flush
        >
          {!locator.role ? (
            <div className="panel-body">
              <StateView
                kind="empty"
                title="Start from the locator"
                detail="Select a role and territory before opening scoped users."
                action={
                  <Link className="btn btn-primary" href="/admin/manage/territory">
                    Open locator
                  </Link>
                }
              />
            </div>
          ) : (
            <DataTable
              head={
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Territory</th>
                  <th>Status</th>
                  <th className="actions">Action</th>
                </tr>
              }
            >
              {managedUsers.length === 0 ? (
                <EmptyRow colSpan={5}>No users found in this territory for the selected role.</EmptyRow>
              ) : (
                managedUsers.map((item) => (
                  <tr key={item.userId}>
                    <td>
                      <strong>{item.name}</strong>
                      <div className="muted-text">{item.email}</div>
                    </td>
                    <td className="muted-text">
                      {item.role.replace(/_/g, " ").toLowerCase()}
                      {item.adminLevel ? <div>{item.adminLevel.replace(/_/g, " ").toLowerCase()}</div> : null}
                      {item.officeType ? <div>{item.officeType.replace(/_/g, " ").toLowerCase()}</div> : null}
                    </td>
                    <td className="muted-text">{describeTerritory(item.territory)}</td>
                    <td>
                      <span className={item.isActive ? "pill pill-executed" : "pill pill-stale"}>
                        {item.isActive ? "active" : "inactive"}
                      </span>
                    </td>
                    <td className="actions">
                      <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                        {item.role === "ADMIN" || item.role === "CANDIDATE" || item.role === "AGENT" ? (
                          <Link
                            className="btn btn-sm"
                            href={`/admin/manage/create?mode=edit&role=${encodeURIComponent(item.role)}&userId=${encodeURIComponent(item.userId)}`}
                          >
                            Edit
                          </Link>
                        ) : null}
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => setConfirmState({ kind: "toggle", item, nextIsActive: !item.isActive })}
                        >
                          {item.isActive ? "Deactivate" : "Reactivate"}
                        </button>
                        {item.role === "AGENT" ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => setConfirmState({ kind: "revoke-session", item })}
                          >
                            Revoke session
                          </button>
                        ) : null}
                        {!item.isActive ? (
                          <button
                            className="btn btn-sm btn-danger"
                            type="button"
                            onClick={() => setConfirmState({ kind: "delete", item })}
                          >
                            Delete
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          )}
        </Panel>
      </div>

      <ConfirmDialog
        open={Boolean(confirmState)}
        title={
          confirmState?.kind === "delete"
            ? "Delete account"
            : confirmState?.kind === "revoke-session"
              ? "Revoke agent session"
              : confirmState?.nextIsActive
                ? "Reactivate account"
                : "Deactivate account"
        }
        description={
          confirmState?.kind === "delete"
            ? `Delete ${confirmState.item.name}'s account? This is permanent and only succeeds when no operational records still depend on it.`
            : confirmState?.kind === "revoke-session"
              ? `Revoke the active device session for ${confirmState.item.name}? The agent will need to sign in again on any device.`
              : confirmState?.nextIsActive
                ? `Reactivate ${confirmState?.item.name}'s account?`
                : `Deactivate ${confirmState?.item.name}'s account? The user will lose access until reactivated.`
        }
        confirmLabel={
          confirmState?.kind === "delete"
            ? "Delete Account"
            : confirmState?.kind === "revoke-session"
              ? "Revoke Session"
              : confirmState?.nextIsActive
                ? "Reactivate Account"
                : "Deactivate Account"
        }
        onCancel={() => !confirmBusy && setConfirmState(null)}
        onConfirm={() => void handleConfirmAction()}
        busy={confirmBusy}
      />
    </main>
  );
}
