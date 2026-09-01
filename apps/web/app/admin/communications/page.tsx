"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AdminLevel,
  AuthUserProfile,
  BroadcastAudiencePreview,
  BroadcastMessageItem,
  CandidateOfficeType,
  LgaItem,
  PoliticalPartyItem,
  StateItem,
  WardItem,
} from "@pics-nigeria/shared";
import {
  ApiError,
  createAdminBroadcast,
  fetchAdminBroadcasts,
  fetchCurrentUser,
  fetchLgas,
  fetchPoliticalParties,
  fetchStates,
  fetchWards,
  previewAdminBroadcast,
} from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { FeedbackBanner } from "../../../components/feedback-banner";
import { describeTerritory } from "../../../components/admin-management-utils";
import { readSession } from "../../../lib/session";

const adminLevels: AdminLevel[] = ["NATIONAL", "GEO_POLITICAL_ZONE", "STATE", "SENATORIAL", "FEDERAL_CONSTITUENCY", "STATE_CONSTITUENCY", "LGA", "WARD"];
const officeTypes: CandidateOfficeType[] = ["PRESIDENTIAL", "GOVERNORSHIP", "SENATE", "HOUSE_OF_REP", "STATE_ASSEMBLY", "CHAIRMANSHIP", "COUNCILLOR"];

function readPartyLabel(parties: PoliticalPartyItem[], partyId: string | null) {
  if (!partyId) {
    return "All visible parties";
  }

  return parties.find((party) => party.id === partyId)?.name || partyId;
}

export default function AdminCommunicationsPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [broadcasts, setBroadcasts] = useState<BroadcastMessageItem[]>([]);
  const [preview, setPreview] = useState<BroadcastAudiencePreview | null>(null);
  const [states, setStates] = useState<StateItem[]>([]);
  const [lgas, setLgas] = useState<LgaItem[]>([]);
  const [wards, setWards] = useState<WardItem[]>([]);
  const [parties, setParties] = useState<PoliticalPartyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    title: "",
    message: "",
    audience: "AGENTS" as "ALL" | "ADMINS" | "AGENTS" | "VOTERS" | "CANDIDATES",
    taskStatus: "",
    politicalPartyId: "",
    adminLevel: "",
    officeType: "",
    stateId: "",
    lgaId: "",
    wardId: "",
  });

  const previewKey = useMemo(
    () =>
      JSON.stringify({
        audience: form.audience,
        taskStatus: form.taskStatus,
        politicalPartyId: form.politicalPartyId,
        adminLevel: form.adminLevel,
        officeType: form.officeType,
        stateId: form.stateId,
        lgaId: form.lgaId,
        wardId: form.wardId,
      }),
    [form.adminLevel, form.audience, form.lgaId, form.officeType, form.politicalPartyId, form.stateId, form.taskStatus, form.wardId],
  );
  const [previewSignature, setPreviewSignature] = useState("");
  const previewIsStale = preview && previewSignature !== previewKey;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canSend =
    !submitting &&
    !previewLoading &&
    Boolean(form.title.trim()) &&
    Boolean(form.message.trim()) &&
    Boolean(preview) &&
    !previewIsStale &&
    (preview?.recipientCount || 0) > 0;

  async function loadPage(token: string) {
    const [currentUser, history, nextStates, nextParties] = await Promise.all([
      fetchCurrentUser(token),
      fetchAdminBroadcasts(token),
      fetchStates(token),
      fetchPoliticalParties(token),
    ]);

    if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
      throw new ApiError("This page is available to admins only.", 403);
    }

    setUser(currentUser);
    setBroadcasts(history);
    setStates(nextStates);
    setParties(nextParties);
    setForm((current) => ({
      ...current,
      stateId: current.stateId || currentUser.adminProfile?.stateId || "",
      lgaId: current.lgaId || currentUser.adminProfile?.lgaId || "",
      wardId: current.wardId || currentUser.adminProfile?.wardId || "",
    }));
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    loadPage(token)
      .catch((caughtError) => setError(caughtError instanceof Error ? caughtError.message : "Could not load communications."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const token = readSession();
    if (!token || !form.stateId) {
      setLgas([]);
      return;
    }

    fetchLgas(token, form.stateId).then(setLgas).catch(() => setLgas([]));
  }, [form.stateId]);

  useEffect(() => {
    const token = readSession();
    if (!token || !form.stateId || !form.lgaId) {
      setWards([]);
      return;
    }

    fetchWards(token, form.stateId, form.lgaId).then(setWards).catch(() => setWards([]));
  }, [form.lgaId, form.stateId]);

  function updateAudience(nextAudience: typeof form.audience) {
    setForm((current) => ({
      ...current,
      audience: nextAudience,
      taskStatus: ["AGENTS", "ALL"].includes(nextAudience) ? current.taskStatus : "",
      adminLevel: ["ADMINS", "ALL"].includes(nextAudience) ? current.adminLevel : "",
      officeType: ["CANDIDATES", "ALL"].includes(nextAudience) ? current.officeType : "",
      politicalPartyId: nextAudience === "VOTERS" ? "" : current.politicalPartyId,
    }));
  }

  async function handlePreview() {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setPreviewLoading(true);
      setError("");
      setMessage("");
      const result = await previewAdminBroadcast(token, {
        title: form.title || "Preview",
        message: form.message || "Preview message",
        audience: form.audience,
        taskStatus: (form.taskStatus || undefined) as "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE" | undefined,
        politicalPartyId: form.politicalPartyId || undefined,
        adminLevel: form.adminLevel as AdminLevel || undefined,
        officeType: form.officeType as CandidateOfficeType || undefined,
        stateId: form.stateId || undefined,
        lgaId: form.lgaId || undefined,
        wardId: form.wardId || undefined,
      });
      setPreview(result.preview);
      setPreviewSignature(previewKey);
    } catch (caughtError) {
      setPreview(null);
      setPreviewSignature("");
      setError(caughtError instanceof Error ? caughtError.message : "Could not preview the target audience.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function submitCommunication() {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    if (!preview || previewSignature !== previewKey) {
      setError("Preview the current audience before sending this communication.");
      return;
    }

    if (preview.recipientCount === 0) {
      setError("No visible recipients match the current communication target.");
      return;
    }

    try {
      setSubmitting(true);
      setError("");
      setMessage("");
      const result = await createAdminBroadcast(token, {
        title: form.title,
        message: form.message,
        audience: form.audience,
        taskStatus: (form.taskStatus || undefined) as "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE" | undefined,
        politicalPartyId: form.politicalPartyId || undefined,
        adminLevel: form.adminLevel as AdminLevel || undefined,
        officeType: form.officeType as CandidateOfficeType || undefined,
        stateId: form.stateId || undefined,
        lgaId: form.lgaId || undefined,
        wardId: form.wardId || undefined,
      });
      setMessage(result.message);
      setForm({
        title: "",
        message: "",
        audience: "AGENTS",
        taskStatus: "",
        politicalPartyId: "",
        adminLevel: "",
        officeType: "",
        stateId: user?.adminProfile?.stateId || "",
        lgaId: user?.adminProfile?.lgaId || "",
        wardId: user?.adminProfile?.wardId || "",
      });
      setPreview(null);
      setPreviewSignature("");
      await loadPage(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not send the communication.");
    } finally {
      setConfirmOpen(false);
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirmOpen(true);
  }

  if (loading) {
    return (
      <main className="shell">
        <section className="panel hero">
          <h1>Loading communications...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load communications</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/admin/dashboard">Return to admin overview</Link>
        </section>
      </main>
    );
  }

  return (
    <>
      <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Communications</p>
        <h1>Targeted messaging</h1>
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
      <FeedbackBanner tone="success" message={message} />

      <section className="grid" style={{ gridTemplateColumns: "minmax(320px, 2fr) minmax(280px, 1fr)", gap: 24 }}>
        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Create communication</h2>
              <p className="muted">Choose role, territory, party, and workflow filters before sending.</p>
            </div>
          </div>
          <form className="form" onSubmit={handleSubmit}>
            <label className="field">
              <span>Title</span>
              <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} minLength={3} required />
            </label>
            <label className="field">
              <span>Message</span>
              <textarea rows={5} value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} minLength={5} required />
            </label>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              <label className="field">
                <span>Audience</span>
                <select value={form.audience} onChange={(event) => {
                  setMessage("");
                  updateAudience(event.target.value as typeof form.audience);
                }}>
                  <option value="AGENTS">Agents</option>
                  <option value="ADMINS">Admins</option>
                  <option value="VOTERS">Voters</option>
                  <option value="CANDIDATES">Candidates</option>
                  <option value="ALL">All visible roles</option>
                </select>
              </label>
              <label className="field">
                <span>Political party</span>
                <select
                  value={form.politicalPartyId}
                  onChange={(event) => {
                    setMessage("");
                    setForm({ ...form, politicalPartyId: event.target.value });
                  }}
                  disabled={form.audience === "VOTERS"}
                >
                  <option value="">All visible parties</option>
                  {parties.map((party) => (
                    <option key={party.id} value={party.id}>{party.name}</option>
                  ))}
                </select>
                {form.audience === "VOTERS" ? (
                  <small className="muted">Party targeting is available only for party-linked recipient roles.</small>
                ) : null}
              </label>
              <label className="field">
                <span>State</span>
                <select value={form.stateId} onChange={(event) => {
                  setMessage("");
                  setForm({ ...form, stateId: event.target.value, lgaId: "", wardId: "" });
                }}>
                  <option value="">All allowed states</option>
                  {states.filter((item) => !user.adminProfile?.stateId || item.id === user.adminProfile.stateId).map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>LGA</span>
                <select value={form.lgaId} onChange={(event) => {
                  setMessage("");
                  setForm({ ...form, lgaId: event.target.value, wardId: "" });
                }} disabled={!form.stateId}>
                  <option value="">All allowed LGAs</option>
                  {lgas.filter((item) => !user.adminProfile?.lgaId || item.id === user.adminProfile.lgaId).map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Ward</span>
                <select value={form.wardId} onChange={(event) => {
                  setMessage("");
                  setForm({ ...form, wardId: event.target.value });
                }} disabled={!form.lgaId}>
                  <option value="">All allowed wards</option>
                  {wards.filter((item) => !user.adminProfile?.wardId || item.id === user.adminProfile.wardId).map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Agent task status</span>
                <select value={form.taskStatus} onChange={(event) => {
                  setMessage("");
                  setForm({ ...form, taskStatus: event.target.value });
                }} disabled={!["AGENTS", "ALL"].includes(form.audience)}>
                  <option value="">All task states</option>
                  <option value="TODO">Todo</option>
                  <option value="IN_PROGRESS">In progress</option>
                  <option value="BLOCKED">Blocked</option>
                  <option value="DONE">Done</option>
                </select>
              </label>
              <label className="field">
                <span>Admin level</span>
                <select value={form.adminLevel} onChange={(event) => {
                  setMessage("");
                  setForm({ ...form, adminLevel: event.target.value });
                }} disabled={!["ADMINS", "ALL"].includes(form.audience)}>
                  <option value="">All admin levels</option>
                  {adminLevels.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Candidate office</span>
                <select value={form.officeType} onChange={(event) => {
                  setMessage("");
                  setForm({ ...form, officeType: event.target.value });
                }} disabled={!["CANDIDATES", "ALL"].includes(form.audience)}>
                  <option value="">All candidate offices</option>
                  {officeTypes.map((office) => (
                    <option key={office} value={office}>{office}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="action-row">
              <button className="button secondary" type="button" onClick={() => void handlePreview()} disabled={previewLoading || submitting}>
                {previewLoading ? "Previewing..." : "Preview Audience"}
              </button>
              <button className="button" type="submit" disabled={!canSend}>
                {submitting ? "Sending..." : "Send Communication"}
              </button>
            </div>
            {!canSend ? (
              <p className="muted">
                Preview the current audience and confirm at least one visible recipient before sending.
              </p>
            ) : null}
          </form>
        </section>

        <section className="panel card">
          <h2>Target summary</h2>
          {!preview ? (
            <p className="muted">Preview the audience before sending to see the exact scoped recipient breakdown.</p>
          ) : (
            <div className="reward-list">
              <article className="reward-item">
                <strong>{preview.recipientCount} recipients</strong>
                <p>Audience: {preview.filters.audience}</p>
                <p>Territory: {describeTerritory(preview.territory)}</p>
              </article>
              <article className="reward-item">
                <strong>Role breakdown</strong>
                <p>Admins: {preview.breakdown.admins}</p>
                <p>Agents: {preview.breakdown.agents}</p>
                <p>Voters: {preview.breakdown.voters}</p>
                <p>Candidates: {preview.breakdown.candidates}</p>
              </article>
              <article className="reward-item">
                <strong>Applied filters</strong>
                <p>Party: {readPartyLabel(parties, preview.filters.politicalPartyId)}</p>
                <p>Task status: {preview.filters.taskStatus || "All task states"}</p>
                <p>Admin level: {preview.filters.adminLevel || "All admin levels"}</p>
                <p>Candidate office: {preview.filters.officeType || "All candidate offices"}</p>
              </article>
            </div>
          )}
          {previewIsStale ? (
            <p className="muted" style={{ marginTop: 16 }}>
              Audience filters changed after the last preview. Preview again before sending.
            </p>
          ) : null}
        </section>
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <div className="section-head">
          <div>
            <h2>Recent communications</h2>
            <p className="muted">Messages already sent through the existing admin broadcast channel.</p>
          </div>
          <span className="status-pill">{broadcasts.length} visible</span>
        </div>

        {broadcasts.length === 0 ? (
          <p className="muted">No broadcasts are visible in your current scope.</p>
        ) : (
          <div className="reward-list">
            {broadcasts.slice(0, 12).map((broadcast) => (
              <article key={broadcast.id} className="reward-item">
                <strong>{broadcast.title}</strong>
                <p>{broadcast.message}</p>
                <p className="muted">
                  {broadcast.audience} | {broadcast.recipientCount} recipients | {new Date(broadcast.createdAt).toLocaleString()}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>
      </main>
      <ConfirmDialog
        open={confirmOpen}
        title="Confirm communication send"
        description={preview ? `Send this communication to ${preview.recipientCount} previewed recipients?` : ""}
        confirmLabel="Send Communication"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void submitCommunication()}
        busy={submitting}
      />
    </>
  );
}
