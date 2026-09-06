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
import {
  DataTable,
  DetailList,
  EmptyRow,
  Field,
  Notice,
  PageHead,
  Panel,
  StateView,
  formatCount,
} from "../../../components/ui";
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
      <main className="console-shell">
        <PageHead title="Communications" />
        <StateView kind="loading" title="Loading communications…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Communications" />
        <StateView
          kind="error"
          title="Unable to load communications"
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
    <>
      <main className="console-shell">
        <PageHead
          title="Targeted messaging"
          lead={`Visible scope: ${describeTerritory(
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
          <FeedbackBanner tone="success" message={message} />

          <div className="workbench">
            <Panel title="Create communication" meta="Role, territory, party and workflow filters">
              <form className="stack-3" onSubmit={handleSubmit}>
                <Field label="Title">
                  <input
                    value={form.title}
                    onChange={(event) => setForm({ ...form, title: event.target.value })}
                    minLength={3}
                    required
                  />
                </Field>
                <Field label="Message">
                  <textarea
                    rows={5}
                    value={form.message}
                    onChange={(event) => setForm({ ...form, message: event.target.value })}
                    minLength={5}
                    required
                  />
                </Field>

                <div className="form-grid">
                  <Field label="Audience">
                    <select
                      value={form.audience}
                      onChange={(event) => {
                        setMessage("");
                        updateAudience(event.target.value as typeof form.audience);
                      }}
                    >
                      <option value="AGENTS">Agents</option>
                      <option value="ADMINS">Admins</option>
                      <option value="VOTERS">Voters</option>
                      <option value="CANDIDATES">Candidates</option>
                      <option value="ALL">All visible roles</option>
                    </select>
                  </Field>

                  <Field
                    label="Political party"
                    hint={
                      form.audience === "VOTERS"
                        ? "Party targeting is available only for party-linked recipient roles."
                        : undefined
                    }
                  >
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
                        <option key={party.id} value={party.id}>
                          {party.name}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="State">
                    <select
                      value={form.stateId}
                      onChange={(event) => {
                        setMessage("");
                        setForm({ ...form, stateId: event.target.value, lgaId: "", wardId: "" });
                      }}
                    >
                      <option value="">All allowed states</option>
                      {states
                        .filter((item) => !user.adminProfile?.stateId || item.id === user.adminProfile.stateId)
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                  </Field>

                  <Field label="LGA">
                    <select
                      value={form.lgaId}
                      onChange={(event) => {
                        setMessage("");
                        setForm({ ...form, lgaId: event.target.value, wardId: "" });
                      }}
                      disabled={!form.stateId}
                    >
                      <option value="">All allowed LGAs</option>
                      {lgas
                        .filter((item) => !user.adminProfile?.lgaId || item.id === user.adminProfile.lgaId)
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                  </Field>

                  <Field label="Ward">
                    <select
                      value={form.wardId}
                      onChange={(event) => {
                        setMessage("");
                        setForm({ ...form, wardId: event.target.value });
                      }}
                      disabled={!form.lgaId}
                    >
                      <option value="">All allowed wards</option>
                      {wards
                        .filter((item) => !user.adminProfile?.wardId || item.id === user.adminProfile.wardId)
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                    </select>
                  </Field>

                  <Field label="Agent task status">
                    <select
                      value={form.taskStatus}
                      onChange={(event) => {
                        setMessage("");
                        setForm({ ...form, taskStatus: event.target.value });
                      }}
                      disabled={!["AGENTS", "ALL"].includes(form.audience)}
                    >
                      <option value="">All task states</option>
                      <option value="TODO">Todo</option>
                      <option value="IN_PROGRESS">In progress</option>
                      <option value="BLOCKED">Blocked</option>
                      <option value="DONE">Done</option>
                    </select>
                  </Field>

                  <Field label="Admin level">
                    <select
                      value={form.adminLevel}
                      onChange={(event) => {
                        setMessage("");
                        setForm({ ...form, adminLevel: event.target.value });
                      }}
                      disabled={!["ADMINS", "ALL"].includes(form.audience)}
                    >
                      <option value="">All admin levels</option>
                      {adminLevels.map((level) => (
                        <option key={level} value={level}>
                          {level.replace(/_/g, " ").toLowerCase()}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Candidate office">
                    <select
                      value={form.officeType}
                      onChange={(event) => {
                        setMessage("");
                        setForm({ ...form, officeType: event.target.value });
                      }}
                      disabled={!["CANDIDATES", "ALL"].includes(form.audience)}
                    >
                      <option value="">All candidate offices</option>
                      {officeTypes.map((office) => (
                        <option key={office} value={office}>
                          {office.replace(/_/g, " ").toLowerCase()}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="btn-row">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void handlePreview()}
                    disabled={previewLoading || submitting}
                  >
                    {previewLoading ? "Previewing…" : "Preview audience"}
                  </button>
                  <button className="btn btn-primary" type="submit" disabled={!canSend}>
                    {submitting ? "Sending…" : "Send communication"}
                  </button>
                </div>
                {!canSend ? (
                  <p className="muted-text">
                    Preview the current audience and confirm at least one visible recipient before sending.
                  </p>
                ) : null}
              </form>
            </Panel>

            <Panel
              title="Target summary"
              meta={preview ? `${formatCount(preview.recipientCount)} recipients` : "Not previewed"}
            >
              {!preview ? (
                <StateView
                  kind="empty"
                  title="No audience previewed"
                  detail="Preview the audience before sending to see the exact scoped recipient breakdown."
                />
              ) : (
                <div className="stack-3">
                  {previewIsStale ? (
                    <Notice tone="refused" title="Preview is out of date">
                      <span>Audience filters changed after the last preview. Preview again before sending.</span>
                    </Notice>
                  ) : null}
                  <DetailList
                    rows={[
                      { label: "Recipients", value: <strong>{formatCount(preview.recipientCount)}</strong> },
                      { label: "Audience", value: preview.filters.audience },
                      { label: "Territory", value: describeTerritory(preview.territory) },
                      { label: "Admins", value: formatCount(preview.breakdown.admins) },
                      { label: "Agents", value: formatCount(preview.breakdown.agents) },
                      { label: "Voters", value: formatCount(preview.breakdown.voters) },
                      { label: "Candidates", value: formatCount(preview.breakdown.candidates) },
                      { label: "Party", value: readPartyLabel(parties, preview.filters.politicalPartyId) },
                      { label: "Task status", value: preview.filters.taskStatus || "All task states" },
                      { label: "Admin level", value: preview.filters.adminLevel || "All admin levels" },
                      { label: "Candidate office", value: preview.filters.officeType || "All candidate offices" },
                    ]}
                  />
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Recent communications" meta={`${formatCount(broadcasts.length)} visible`} flush>
            <DataTable
              head={
                <tr>
                  <th>Message</th>
                  <th>Audience</th>
                  <th className="numeric">Recipients</th>
                  <th>Sent</th>
                </tr>
              }
            >
              {broadcasts.length === 0 ? (
                <EmptyRow colSpan={4}>No broadcasts are visible in your current scope.</EmptyRow>
              ) : (
                broadcasts.slice(0, 20).map((broadcast) => (
                  <tr key={broadcast.id}>
                    <td>
                      <strong>{broadcast.title}</strong>
                      <div className="muted-text">{broadcast.message}</div>
                    </td>
                    <td className="muted-text">{broadcast.audience.toLowerCase()}</td>
                    <td className="numeric">{formatCount(broadcast.recipientCount)}</td>
                    <td className="muted-text">{new Date(broadcast.createdAt).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>
        </div>
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
