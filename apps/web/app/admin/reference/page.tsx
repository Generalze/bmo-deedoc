"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import type { AuthUserProfile, GeoPoliticalZoneItem, PoliticalPartyItem, ReferenceCompletenessReport } from "@pics-nigeria/shared";
import {
  ApiError,
  createGeoPoliticalZone,
  createPoliticalParty,
  deleteGeoPoliticalZone,
  deletePoliticalParty,
  fetchAdminReferenceCompleteness,
  fetchCurrentUser,
  fetchGeoPoliticalZones,
  fetchPoliticalParties,
  updateGeoPoliticalZone,
  updatePoliticalParty,
} from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { FeedbackBanner } from "../../../components/feedback-banner";
import { clearSession, readSession } from "../../../lib/session";

function formatDependencyCounts(dependencyCounts?: Record<string, number>) {
  if (!dependencyCounts) {
    return "";
  }

  const entries = Object.entries(dependencyCounts).filter(([, count]) => count > 0);
  return entries.map(([key, count]) => `${key}: ${count}`).join(", ");
}

export default function AdminReferencePage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [zones, setZones] = useState<GeoPoliticalZoneItem[]>([]);
  const [parties, setParties] = useState<PoliticalPartyItem[]>([]);
  const [completeness, setCompleteness] = useState<ReferenceCompletenessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [editingPartyId, setEditingPartyId] = useState<string | null>(null);
  const [zoneForm, setZoneForm] = useState({ id: "", name: "" });
  const [zoneEditForm, setZoneEditForm] = useState({ name: "" });
  const [partyForm, setPartyForm] = useState({
    id: "",
    code: "",
    name: "",
    logoUrl: "",
    description: "",
    officialWebsite: "",
    isApprovedByInec: false,
    inecSourceUrl: "",
  });
  const [partyEditForm, setPartyEditForm] = useState({
    code: "",
    name: "",
    logoUrl: "",
    description: "",
    officialWebsite: "",
    isApprovedByInec: false,
    inecSourceUrl: "",
  });
  const [pendingDelete, setPendingDelete] = useState<{ kind: "zone" | "party"; id: string; name: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function loadReferenceData(token: string) {
    const [currentUser, nextZones, nextParties, referenceCompleteness] = await Promise.all([
      fetchCurrentUser(token),
      fetchGeoPoliticalZones(token),
      fetchPoliticalParties(token),
      fetchAdminReferenceCompleteness(token),
    ]);

    if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
      throw new ApiError("This page is available to admins only.", 403);
    }

    setUser(currentUser);
    setZones(nextZones);
    setParties(nextParties);
    setCompleteness(referenceCompleteness);
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    loadReferenceData(token)
      .catch((caughtError) => {
        // Only a real authentication failure clears the session. A 403 means this
        // screen is above the operator's role, not that they are signed out.
        if (caughtError instanceof ApiError && caughtError.status === 401) {
          clearSession();
        }
        setError(caughtError instanceof Error ? caughtError.message : "Could not load reference data.");
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleCreateZone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      await createGeoPoliticalZone(token, zoneForm);
      setZones(await fetchGeoPoliticalZones(token));
      setZoneForm({ id: "", name: "" });
      setMessage("Geo-political zone created.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not create geo-political zone.");
    }
  }

  async function handleUpdateZone(zoneId: string) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      await updateGeoPoliticalZone(token, zoneId, zoneEditForm);
      setZones(await fetchGeoPoliticalZones(token));
      setEditingZoneId(null);
      setZoneEditForm({ name: "" });
      setMessage("Geo-political zone updated.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not update geo-political zone.");
    }
  }

  async function handleDeleteZone(zoneId: string) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setDeleteBusy(true);
      setError("");
      await deleteGeoPoliticalZone(token, zoneId);
      setZones(await fetchGeoPoliticalZones(token));
      setMessage("Geo-political zone deleted.");
    } catch (caughtError) {
      if (caughtError instanceof ApiError) {
        const details = formatDependencyCounts((caughtError.details as { dependencyCounts?: Record<string, number> } | undefined)?.dependencyCounts);
        setError(details ? `${caughtError.message} ${details}` : caughtError.message);
        return;
      }

      setError(caughtError instanceof Error ? caughtError.message : "Could not delete geo-political zone.");
    } finally {
      setDeleteBusy(false);
      setPendingDelete(null);
    }
  }

  async function handleCreateParty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      await createPoliticalParty(token, partyForm);
      setParties(await fetchPoliticalParties(token));
      setPartyForm({
        id: "",
        code: "",
        name: "",
        logoUrl: "",
        description: "",
        officialWebsite: "",
        isApprovedByInec: false,
        inecSourceUrl: "",
      });
      setMessage("Political party created.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not create political party.");
    }
  }

  async function handleUpdateParty(partyId: string) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      await updatePoliticalParty(token, partyId, partyEditForm);
      setParties(await fetchPoliticalParties(token));
      setEditingPartyId(null);
      setPartyEditForm({
        code: "",
        name: "",
        logoUrl: "",
        description: "",
        officialWebsite: "",
        isApprovedByInec: false,
        inecSourceUrl: "",
      });
      setMessage("Political party updated.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not update political party.");
    }
  }

  async function handleDeleteParty(partyId: string) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setDeleteBusy(true);
      setError("");
      await deletePoliticalParty(token, partyId);
      setParties(await fetchPoliticalParties(token));
      setMessage("Political party deleted.");
    } catch (caughtError) {
      if (caughtError instanceof ApiError) {
        const details = formatDependencyCounts((caughtError.details as { dependencyCounts?: Record<string, number> } | undefined)?.dependencyCounts);
        setError(details ? `${caughtError.message} ${details}` : caughtError.message);
        return;
      }

      setError(caughtError instanceof Error ? caughtError.message : "Could not delete political party.");
    } finally {
      setDeleteBusy(false);
      setPendingDelete(null);
    }
  }

  if (loading) {
    return (
      <main className="shell">
        <section className="panel hero">
          <h1>Loading reference data...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load reference data</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/login">Return to admin login</Link>
        </section>
      </main>
    );
  }

  const isSuperAdmin = user.role === "SUPER_ADMIN";

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Reference data</p>
        <h1>Zones and parties</h1>
        <p>Manage the reference structures used by candidate creation and public party discovery.</p>
      </section>

      <AdminNav role={user?.role} />

      <FeedbackBanner tone="error" message={error} />
      <FeedbackBanner tone="success" message={message} />

      {completeness ? (
        <>
          <section className="grid stats" style={{ marginTop: 24 }}>
            <article className="panel card">
              <h2>States</h2>
              <div className="value">{completeness.summary.loadedStates}</div>
              <p className="muted">Expected in scope: {completeness.summary.expectedStates}</p>
            </article>
            <article className="panel card">
              <h2>LGAs</h2>
              <div className="value">{completeness.summary.loadedLgas}</div>
              <p className="muted">Expected in scope: {completeness.summary.expectedLgas}</p>
            </article>
            <article className="panel card">
              <h2>Wards</h2>
              <div className="value">{completeness.summary.loadedWards}</div>
              <p className="muted">Wards without polling units: {completeness.summary.wardsWithoutPollingUnits}</p>
            </article>
            <article className="panel card">
              <h2>Polling units</h2>
              <div className="value">{completeness.summary.loadedPollingUnits}</div>
              <p className="muted">LGAs without wards: {completeness.summary.lgasWithoutWards}</p>
            </article>
          </section>

          <section className="panel card" style={{ marginTop: 24 }}>
            <div className="section-head">
              <div>
                <h2>Reference completeness</h2>
                <p className="muted">
                  This is a read-only readiness view for national reference coverage. Full polling-unit bootstrap is now a controlled manual ops task.
                </p>
              </div>
              <p className="muted" style={{ maxWidth: 420 }}>
                Manual command: <code>{completeness.manualBootstrapCommand}</code>
              </p>
            </div>

            <div className="reward-list" style={{ marginTop: 16 }}>
              {completeness.states.map((state) => (
                <article key={state.stateId} className="reward-item">
                  <div className="section-head compact">
                    <div>
                      <strong>{state.stateName}</strong>
                      <p className="muted">
                        LGAs {state.loadedLgas}/{state.expectedLgas} | Wards {state.loadedWards} | Polling units {state.loadedPollingUnits}
                      </p>
                    </div>
                    <span className={`status-pill ${state.isComplete ? "active" : "inactive"}`}>
                      {state.isComplete ? "Ready" : "Incomplete"}
                    </span>
                  </div>
                  <p className="muted">
                    Missing LGAs: {state.missingLgas} | LGAs without wards: {state.lgasWithoutWards} | Wards without polling units: {state.wardsWithoutPollingUnits}
                  </p>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : null}

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <section className="panel card">
          <h2>Geo-political zones</h2>
          {isSuperAdmin ? (
            <form className="form" onSubmit={handleCreateZone}>
              <label className="field">
                <span>Zone ID</span>
                <input value={zoneForm.id} onChange={(event) => setZoneForm({ ...zoneForm, id: event.target.value })} required />
              </label>
              <label className="field">
                <span>Zone name</span>
                <input value={zoneForm.name} onChange={(event) => setZoneForm({ ...zoneForm, name: event.target.value })} required />
              </label>
              <button className="button" type="submit">Create zone</button>
            </form>
          ) : (
            <p className="muted">Only super admin can create, update, or delete zones.</p>
          )}

          <div className="reward-list" style={{ marginTop: 16 }}>
            {zones.map((zone) => (
              <article key={zone.id} className="reward-item">
                <strong>{zone.name}</strong>
                <p className="muted">{zone.id}</p>
                {editingZoneId === zone.id ? (
                  <div className="form">
                    <label className="field">
                      <span>Rename zone</span>
                      <input value={zoneEditForm.name} onChange={(event) => setZoneEditForm({ name: event.target.value })} />
                    </label>
                    <div className="action-row">
                      <button className="button" type="button" onClick={() => void handleUpdateZone(zone.id)}>Save</button>
                      <button className="button secondary" type="button" onClick={() => setEditingZoneId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : isSuperAdmin ? (
                  <div className="action-row">
                    <button className="button secondary" type="button" onClick={() => { setEditingZoneId(zone.id); setZoneEditForm({ name: zone.name }); }}>Edit</button>
                     <button
                       className="button danger"
                       type="button"
                       onClick={() => setPendingDelete({ kind: "zone", id: zone.id, name: zone.name })}
                     >
                       Delete
                     </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        <section className="panel card">
          <h2>Political parties</h2>
          {isSuperAdmin ? (
            <form className="form" onSubmit={handleCreateParty}>
              <label className="field">
                <span>Party ID</span>
                <input value={partyForm.id} onChange={(event) => setPartyForm({ ...partyForm, id: event.target.value })} required />
              </label>
              <label className="field">
                <span>Code</span>
                <input value={partyForm.code} onChange={(event) => setPartyForm({ ...partyForm, code: event.target.value })} required />
              </label>
              <label className="field">
                <span>Name</span>
                <input value={partyForm.name} onChange={(event) => setPartyForm({ ...partyForm, name: event.target.value })} required />
              </label>
              <label className="field">
                <span>Logo URL</span>
                <input value={partyForm.logoUrl} onChange={(event) => setPartyForm({ ...partyForm, logoUrl: event.target.value })} />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea rows={4} value={partyForm.description} onChange={(event) => setPartyForm({ ...partyForm, description: event.target.value })} />
              </label>
              <label className="field">
                <span>Official website</span>
                <input value={partyForm.officialWebsite} onChange={(event) => setPartyForm({ ...partyForm, officialWebsite: event.target.value })} />
              </label>
              <label className="checkbox-field">
                <input type="checkbox" checked={partyForm.isApprovedByInec} onChange={(event) => setPartyForm({ ...partyForm, isApprovedByInec: event.target.checked })} />
                <span>Mark as INEC approved</span>
              </label>
              <label className="field">
                <span>INEC source URL</span>
                <input value={partyForm.inecSourceUrl} onChange={(event) => setPartyForm({ ...partyForm, inecSourceUrl: event.target.value })} />
              </label>
              <button className="button" type="submit">Create party</button>
            </form>
          ) : (
            <p className="muted">Only super admin can create, update, or delete parties.</p>
          )}

          <div className="reward-list" style={{ marginTop: 16 }}>
            {parties.map((party) => (
              <article key={party.id} className="reward-item">
                <strong>{party.code} - {party.name}</strong>
                <p className="muted">{party.isApprovedByInec ? "INEC approved" : "Custom / local record"}</p>
                {party.description ? <p>{party.description}</p> : null}
                {editingPartyId === party.id ? (
                  <div className="form">
                    <label className="field">
                      <span>Code</span>
                      <input value={partyEditForm.code} onChange={(event) => setPartyEditForm({ ...partyEditForm, code: event.target.value })} />
                    </label>
                    <label className="field">
                      <span>Name</span>
                      <input value={partyEditForm.name} onChange={(event) => setPartyEditForm({ ...partyEditForm, name: event.target.value })} />
                    </label>
                    <label className="field">
                      <span>Logo URL</span>
                      <input value={partyEditForm.logoUrl} onChange={(event) => setPartyEditForm({ ...partyEditForm, logoUrl: event.target.value })} />
                    </label>
                    <label className="field">
                      <span>Description</span>
                      <textarea rows={3} value={partyEditForm.description} onChange={(event) => setPartyEditForm({ ...partyEditForm, description: event.target.value })} />
                    </label>
                    <label className="field">
                      <span>Official website</span>
                      <input value={partyEditForm.officialWebsite} onChange={(event) => setPartyEditForm({ ...partyEditForm, officialWebsite: event.target.value })} />
                    </label>
                    <label className="checkbox-field">
                      <input type="checkbox" checked={partyEditForm.isApprovedByInec} onChange={(event) => setPartyEditForm({ ...partyEditForm, isApprovedByInec: event.target.checked })} />
                      <span>INEC approved</span>
                    </label>
                    <label className="field">
                      <span>INEC source URL</span>
                      <input value={partyEditForm.inecSourceUrl} onChange={(event) => setPartyEditForm({ ...partyEditForm, inecSourceUrl: event.target.value })} />
                    </label>
                    <div className="action-row">
                      <button className="button" type="button" onClick={() => void handleUpdateParty(party.id)}>Save</button>
                      <button className="button secondary" type="button" onClick={() => setEditingPartyId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : isSuperAdmin ? (
                  <div className="action-row">
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => {
                        setEditingPartyId(party.id);
                        setPartyEditForm({
                          code: party.code,
                          name: party.name,
                          logoUrl: party.logoUrl || "",
                          description: party.description || "",
                          officialWebsite: party.officialWebsite || "",
                          isApprovedByInec: party.isApprovedByInec,
                          inecSourceUrl: party.inecSourceUrl || "",
                        });
                      }}
                    >
                      Edit
                    </button>
                     <button
                       className="button danger"
                       type="button"
                       onClick={() => setPendingDelete({ kind: "party", id: party.id, name: party.name })}
                     >
                       Delete
                     </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </section>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={pendingDelete?.kind === "zone" ? "Delete geo-political zone" : "Delete political party"}
        description={
          pendingDelete
            ? `Delete ${pendingDelete.name}? This action is destructive and will be blocked if dependent records still exist.`
            : ""
        }
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) {
            return;
          }

          if (pendingDelete.kind === "zone") {
            void handleDeleteZone(pendingDelete.id);
            return;
          }

          void handleDeleteParty(pendingDelete.id);
        }}
        busy={deleteBusy}
      />
    </main>
  );
}
