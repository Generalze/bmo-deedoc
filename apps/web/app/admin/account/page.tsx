"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import type { AuthUserProfile } from "@pics-nigeria/shared";
import { ApiError, downloadSuperAdminVoterContacts, fetchCurrentUser, logoutCurrentUser, updateCurrentUserPassword, updateCurrentUserProfile } from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
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
      <main className="shell">
        <section className="panel hero">
          <h1>Loading account settings...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load account</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/login">Return to admin login</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Admin account</p>
        <h1>{user.name}</h1>
        <p>Update your profile, password, and sensitive export tools from one place.</p>
        <div className="action-row" style={{ marginTop: 12 }}>
          <button className="button secondary" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
      </section>

      <AdminNav role={user?.role} />

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <section className="panel card">
          <h2>Change account info</h2>
          <form className="form" onSubmit={handleProfileSubmit}>
            <label className="field">
              <span>Name</span>
              <input value={profileForm.name} onChange={(event) => setProfileForm({ ...profileForm, name: event.target.value })} required />
            </label>
            <label className="field">
              <span>Email</span>
              <input type="email" value={profileForm.email} onChange={(event) => setProfileForm({ ...profileForm, email: event.target.value })} required />
            </label>
            <label className="field">
              <span>Phone</span>
              <input value={profileForm.phone} onChange={(event) => setProfileForm({ ...profileForm, phone: event.target.value })} />
            </label>
            <button className="button" type="submit">Save account</button>
          </form>
        </section>

        <section className="panel card">
          <h2>Change password</h2>
          <form className="form" onSubmit={handlePasswordSubmit}>
            <label className="field">
              <span>Current password</span>
              <input type="password" value={passwordForm.currentPassword} onChange={(event) => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })} required />
            </label>
            <label className="field">
              <span>New password</span>
              <input type="password" value={passwordForm.newPassword} onChange={(event) => setPasswordForm({ ...passwordForm, newPassword: event.target.value })} minLength={8} required />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input type="password" value={passwordForm.confirmNewPassword} onChange={(event) => setPasswordForm({ ...passwordForm, confirmNewPassword: event.target.value })} minLength={8} required />
            </label>
            <button className="button" type="submit">Update password</button>
          </form>
        </section>
      </section>

      {user.role === "SUPER_ADMIN" ? (
        <section className="panel card" style={{ marginTop: 24 }}>
          <h2>Protected export</h2>
          <p className="muted">Export consented voter phone numbers and emails only when operationally necessary.</p>
          <button className="button" type="button" onClick={() => void handleExportContacts()} disabled={exporting}>
            {exporting ? "Exporting..." : "Export consented voter contacts"}
          </button>
        </section>
      ) : null}
    </main>
  );
}
