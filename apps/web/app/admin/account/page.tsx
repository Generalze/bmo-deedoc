"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import type { AuthUserProfile } from "@pics-nigeria/shared";
import { ApiError, downloadSuperAdminVoterContacts, fetchCurrentUser, logoutCurrentUser, updateCurrentUserPassword, updateCurrentUserProfile } from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { Field, Notice, PageHead, Panel, PanelGrid, StateView } from "../../../components/ui";
import { clearSession, readSession } from "../../../lib/session";

export default function AdminAccountPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const [profileForm, setProfileForm] = useState({
    name: "",
    email: "",
    phone: "",
  });
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmNewPassword: "",
  });

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    fetchCurrentUser(token)
      .then((currentUser) => {
        if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
          throw new ApiError("This page is available to admins only.", 403);
        }

        setUser(currentUser);
        setProfileForm({
          name: currentUser.name,
          email: currentUser.email,
          phone: currentUser.phone || "",
        });
      })
      .catch((caughtError) => {
        // Only a real authentication failure clears the session. A 403 means this
        // screen is above the operator's role, not that they are signed out.
        if (caughtError instanceof ApiError && caughtError.status === 401) {
          clearSession();
        }
        setError(caughtError instanceof Error ? caughtError.message : "Could not load account settings.");
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      setMessage("");
      const result = await updateCurrentUserProfile(token, profileForm);
      setUser(result.user);
      setProfileForm({
        name: result.user.name,
        email: result.user.email,
        phone: result.user.phone || "",
      });
      setMessage(result.message);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not update account information.");
    }
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmNewPassword) {
      setError("New password confirmation does not match.");
      return;
    }

    try {
      setError("");
      setMessage("");
      const result = await updateCurrentUserPassword(token, {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      });
      setPasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmNewPassword: "",
      });
      setMessage(result.message);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not update password.");
    }
  }

  async function handleExportContacts() {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      setMessage("");
      setExporting(true);
      const blob = await downloadSuperAdminVoterContacts(token);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `voters-consented-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      window.URL.revokeObjectURL(url);
      setMessage("Consented voter contacts exported successfully.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not export voter contacts.");
    } finally {
      setExporting(false);
    }
  }

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

  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Account" />
        <StateView kind="loading" title="Loading account settings…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Account" />
        <StateView
          kind="error"
          title="Unable to load your account"
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
        title={user.name}
        lead="Your profile, password and export tools."
        actions={
          <button className="btn" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        }
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        {error ? <Notice tone="error" title="Something went wrong">{error}</Notice> : null}
        {message ? <Notice tone="ok" title={message} /> : null}

        <PanelGrid>
          <Panel title="Account details">
            <form className="stack-3" onSubmit={handleProfileSubmit}>
              <Field label="Name">
                <input
                  value={profileForm.name}
                  onChange={(event) => setProfileForm({ ...profileForm, name: event.target.value })}
                  required
                />
              </Field>
              <Field label="Email">
                <input
                  type="email"
                  value={profileForm.email}
                  onChange={(event) => setProfileForm({ ...profileForm, email: event.target.value })}
                  required
                />
              </Field>
              <Field label="Phone">
                <input
                  value={profileForm.phone}
                  onChange={(event) => setProfileForm({ ...profileForm, phone: event.target.value })}
                />
              </Field>
              <div className="btn-row">
                <button className="btn btn-primary" type="submit">
                  Save account
                </button>
              </div>
            </form>
          </Panel>

          <Panel title="Change password">
            <form className="stack-3" onSubmit={handlePasswordSubmit}>
              <Field label="Current password">
                <input
                  type="password"
                  value={passwordForm.currentPassword}
                  onChange={(event) => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })}
                  required
                />
              </Field>
              <Field label="New password" hint="At least 8 characters.">
                <input
                  type="password"
                  value={passwordForm.newPassword}
                  onChange={(event) => setPasswordForm({ ...passwordForm, newPassword: event.target.value })}
                  minLength={8}
                  required
                />
              </Field>
              <Field
                label="Confirm new password"
                error={
                  passwordForm.confirmNewPassword && passwordForm.newPassword !== passwordForm.confirmNewPassword
                    ? "The two passwords do not match."
                    : undefined
                }
              >
                <input
                  type="password"
                  value={passwordForm.confirmNewPassword}
                  onChange={(event) => setPasswordForm({ ...passwordForm, confirmNewPassword: event.target.value })}
                  minLength={8}
                  required
                />
              </Field>
              <div className="btn-row">
                <button className="btn btn-primary" type="submit">
                  Update password
                </button>
              </div>
            </form>
          </Panel>
        </PanelGrid>

        {user.role === "SUPER_ADMIN" ? (
          <Panel title="Protected export">
            <div className="stack-3">
              <Notice tone="legacy" title="Personal contact data">
                <span>
                  This exports consented voter phone numbers and email addresses. Use it only when operationally
                  necessary — contact details are otherwise restricted.
                </span>
              </Notice>
              <div className="btn-row">
                <button className="btn" type="button" onClick={() => void handleExportContacts()} disabled={exporting}>
                  {exporting ? "Exporting…" : "Export consented voter contacts"}
                </button>
              </div>
            </div>
          </Panel>
        ) : null}
      </div>
    </main>
  );
}
