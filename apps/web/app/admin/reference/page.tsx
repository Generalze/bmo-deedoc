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
import {
  DataTable,
  EmptyRow,
  Field,
  Kpi,
  KpiRow,
  Notice,
  PageHead,
  Panel,
  PanelGrid,
  StateView,
  formatCount,
} from "../../../components/ui";
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
      <main className="console-shell">
        <PageHead title="Reference data" />
        <StateView kind="loading" title="Loading reference data…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Reference data" />
        <StateView
          kind="error"
          title="Unable to load reference data"
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

  const isSuperAdmin = user.role === "SUPER_ADMIN";

  return (
    <main className="console-shell">
      <PageHead
        title="Zones and parties"
        lead="The reference structures used by candidate creation and public party discovery."
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        <FeedbackBanner tone="error" message={error} />
        <FeedbackBanner tone="success" message={message} />

        {completeness ? (
          <>
            <KpiRow>
              <Kpi
                label="States"
                value={formatCount(completeness.summary.loadedStates)}
                note={`${formatCount(completeness.summary.expectedStates)} expected in scope`}
                tone={completeness.summary.loadedStates < completeness.summary.expectedStates ? "warn" : undefined}
              />
              <Kpi
                label="LGAs"
                value={formatCount(completeness.summary.loadedLgas)}
                note={`${formatCount(completeness.summary.expectedLgas)} expected in scope`}
                tone={completeness.summary.loadedLgas < completeness.summary.expectedLgas ? "warn" : undefined}
              />
              <Kpi
                label="Wards"
                value={formatCount(completeness.summary.loadedWards)}
                note={`${formatCount(completeness.summary.wardsWithoutPollingUnits)} without Polling Units`}
                tone={completeness.summary.wardsWithoutPollingUnits > 0 ? "warn" : undefined}
              />
              <Kpi
                label="Polling Units"
                value={formatCount(completeness.summary.loadedPollingUnits)}
                note={`${formatCount(completeness.summary.lgasWithoutWards)} LGAs without wards`}
                tone={completeness.summary.lgasWithoutWards > 0 ? "warn" : undefined}
              />
            </KpiRow>

            <Panel
              title="Reference completeness"
              meta="Read-only readiness view"
              flush
            >
              <div className="panel-body stack-2">
                <p className="muted-text">
                  Full Polling Unit bootstrap is a controlled manual operations task, not something this screen runs.
                </p>
                <p className="muted-text">
                  Manual command: <code className="mono">{completeness.manualBootstrapCommand}</code>
                </p>
              </div>
              <DataTable
                head={
                  <tr>
                    <th>State</th>
                    <th className="numeric">LGAs</th>
                    <th className="numeric">Wards</th>
                    <th className="numeric">Polling Units</th>
                    <th className="numeric">Missing LGAs</th>
                    <th className="numeric">LGAs w/o wards</th>
                    <th className="numeric">Wards w/o PUs</th>
                    <th>State</th>
                  </tr>
                }
              >
                {completeness.states.length === 0 ? (
                  <EmptyRow colSpan={8}>No reference states loaded.</EmptyRow>
                ) : (
                  completeness.states.map((state) => (
                    <tr key={state.stateId}>
                      <td>{state.stateName}</td>
                      <td className="numeric">
                        {formatCount(state.loadedLgas)} / {formatCount(state.expectedLgas)}
                      </td>
                      <td className="numeric">{formatCount(state.loadedWards)}</td>
                      <td className="numeric">{formatCount(state.loadedPollingUnits)}</td>
                      <td className="numeric">{formatCount(state.missingLgas)}</td>
                      <td className="numeric">{formatCount(state.lgasWithoutWards)}</td>
                      <td className="numeric">{formatCount(state.wardsWithoutPollingUnits)}</td>
                      <td>
                        <span className={state.isComplete ? "pill pill-executed" : "pill pill-refused"}>
                          {state.isComplete ? "ready" : "incomplete"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </DataTable>
            </Panel>
          </>
        ) : null}

        <PanelGrid wide>
          <Panel title="Geo-political zones" meta={`${formatCount(zones.length)} zones`} flush>
            {isSuperAdmin ? (
              <div className="panel-body">
                <form className="stack-3" onSubmit={handleCreateZone}>
                  <div className="form-grid">
                    <Field label="Zone ID">
                      <input value={zoneForm.id} onChange={(event) => setZoneForm({ ...zoneForm, id: event.target.value })} required />
                    </Field>
                    <Field label="Zone name">
                      <input
                        value={zoneForm.name}
                        onChange={(event) => setZoneForm({ ...zoneForm, name: event.target.value })}
                        required
                      />
                    </Field>
                  </div>
                  <div className="btn-row">
                    <button className="btn btn-primary" type="submit">
                      Create zone
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="panel-body">
                <Notice tone="refused" title="Read only">
                  <span>Only the super admin can create, update or delete zones.</span>
                </Notice>
              </div>
            )}

            <DataTable
              head={
                <tr>
                  <th>Zone</th>
                  <th>ID</th>
                  <th className="actions">Action</th>
                </tr>
              }
            >
              {zones.length === 0 ? (
                <EmptyRow colSpan={3}>No zones defined.</EmptyRow>
              ) : (
                zones.flatMap((zone) => {
                  const editing = editingZoneId === zone.id;
                  const rows = [
                    <tr key={zone.id} className={editing ? "row-open" : undefined}>
                      <td>{zone.name}</td>
                      <td className="mono">{zone.id}</td>
                      <td className="actions">
                        {isSuperAdmin && !editing ? (
                          <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() => {
                                setEditingZoneId(zone.id);
                                setZoneEditForm({ name: zone.name });
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              type="button"
                              onClick={() => setPendingDelete({ kind: "zone", id: zone.id, name: zone.name })}
                            >
                              Delete
                            </button>
                          </span>
                        ) : (
                          <span className="muted-text">—</span>
                        )}
                      </td>
                    </tr>,
                  ];

                  if (editing) {
                    rows.push(
                      <tr key={`${zone.id}-edit`} className="row-editor">
                        <td colSpan={3}>
                          <div className="stack-3">
                            <Field label="Rename zone">
                              <input value={zoneEditForm.name} onChange={(event) => setZoneEditForm({ name: event.target.value })} />
                            </Field>
                            <div className="btn-row">
                              <button className="btn btn-primary" type="button" onClick={() => void handleUpdateZone(zone.id)}>
                                Save
                              </button>
                              <button className="btn" type="button" onClick={() => setEditingZoneId(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>,
                    );
                  }

                  return rows;
                })
              )}
            </DataTable>
          </Panel>

          <Panel title="Political parties" meta={`${formatCount(parties.length)} parties`} flush>
            {isSuperAdmin ? (
              <div className="panel-body">
                <form className="stack-3" onSubmit={handleCreateParty}>
                  <div className="form-grid">
                    <Field label="Party ID">
                      <input value={partyForm.id} onChange={(event) => setPartyForm({ ...partyForm, id: event.target.value })} required />
                    </Field>
                    <Field label="Code">
                      <input
                        value={partyForm.code}
                        onChange={(event) => setPartyForm({ ...partyForm, code: event.target.value })}
                        required
                      />
                    </Field>
                    <Field label="Name">
                      <input
                        value={partyForm.name}
                        onChange={(event) => setPartyForm({ ...partyForm, name: event.target.value })}
                        required
                      />
                    </Field>
                    <Field label="Logo URL">
                      <input value={partyForm.logoUrl} onChange={(event) => setPartyForm({ ...partyForm, logoUrl: event.target.value })} />
                    </Field>
                    <Field label="Official website">
                      <input
                        value={partyForm.officialWebsite}
                        onChange={(event) => setPartyForm({ ...partyForm, officialWebsite: event.target.value })}
                      />
                    </Field>
                    <Field label="INEC source URL" hint="Where the INEC listing was read from.">
                      <input
                        value={partyForm.inecSourceUrl}
                        onChange={(event) => setPartyForm({ ...partyForm, inecSourceUrl: event.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label="Description">
                    <textarea
                      rows={3}
                      value={partyForm.description}
                      onChange={(event) => setPartyForm({ ...partyForm, description: event.target.value })}
                    />
                  </Field>
                  <label className="consent">
                    <input
                      type="checkbox"
                      checked={partyForm.isApprovedByInec}
                      onChange={(event) => setPartyForm({ ...partyForm, isApprovedByInec: event.target.checked })}
                    />
                    <span>Mark as INEC approved</span>
                  </label>
                  <div className="btn-row">
                    <button className="btn btn-primary" type="submit">
                      Create party
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="panel-body">
                <Notice tone="refused" title="Read only">
                  <span>Only the super admin can create, update or delete parties.</span>
                </Notice>
              </div>
            )}

            <DataTable
              head={
                <tr>
                  <th>Party</th>
                  <th>Listing</th>
                  <th className="actions">Action</th>
                </tr>
              }
            >
              {parties.length === 0 ? (
                <EmptyRow colSpan={3}>No parties defined.</EmptyRow>
              ) : (
                parties.flatMap((party) => {
                  const editing = editingPartyId === party.id;
                  const rows = [
                    <tr key={party.id} className={editing ? "row-open" : undefined}>
                      <td>
                        <strong>
                          {party.code} — {party.name}
                        </strong>
                        {party.description ? <div className="muted-text">{party.description}</div> : null}
                      </td>
                      <td>
                        <span className={party.isApprovedByInec ? "pill pill-executed" : "pill pill-stale"}>
                          {party.isApprovedByInec ? "INEC approved" : "custom record"}
                        </span>
                      </td>
                      <td className="actions">
                        {isSuperAdmin && !editing ? (
                          <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                            <button
                              className="btn btn-sm"
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
                              className="btn btn-sm btn-danger"
                              type="button"
                              onClick={() => setPendingDelete({ kind: "party", id: party.id, name: party.name })}
                            >
                              Delete
                            </button>
                          </span>
                        ) : (
                          <span className="muted-text">—</span>
                        )}
                      </td>
                    </tr>,
                  ];

                  if (editing) {
                    rows.push(
                      <tr key={`${party.id}-edit`} className="row-editor">
                        <td colSpan={3}>
                          <div className="stack-3">
                            <div className="form-grid">
                              <Field label="Code">
                                <input
                                  value={partyEditForm.code}
                                  onChange={(event) => setPartyEditForm({ ...partyEditForm, code: event.target.value })}
                                />
                              </Field>
                              <Field label="Name">
                                <input
                                  value={partyEditForm.name}
                                  onChange={(event) => setPartyEditForm({ ...partyEditForm, name: event.target.value })}
                                />
                              </Field>
                              <Field label="Logo URL">
                                <input
                                  value={partyEditForm.logoUrl}
                                  onChange={(event) => setPartyEditForm({ ...partyEditForm, logoUrl: event.target.value })}
                                />
                              </Field>
                              <Field label="Official website">
                                <input
                                  value={partyEditForm.officialWebsite}
                                  onChange={(event) =>
                                    setPartyEditForm({ ...partyEditForm, officialWebsite: event.target.value })
                                  }
                                />
                              </Field>
                              <Field label="INEC source URL">
                                <input
                                  value={partyEditForm.inecSourceUrl}
                                  onChange={(event) =>
                                    setPartyEditForm({ ...partyEditForm, inecSourceUrl: event.target.value })
                                  }
                                />
                              </Field>
                            </div>
                            <Field label="Description">
                              <textarea
                                rows={3}
                                value={partyEditForm.description}
                                onChange={(event) => setPartyEditForm({ ...partyEditForm, description: event.target.value })}
                              />
                            </Field>
                            <label className="consent">
                              <input
                                type="checkbox"
                                checked={partyEditForm.isApprovedByInec}
                                onChange={(event) =>
                                  setPartyEditForm({ ...partyEditForm, isApprovedByInec: event.target.checked })
                                }
                              />
                              <span>INEC approved</span>
                            </label>
                            <div className="btn-row">
                              <button className="btn btn-primary" type="button" onClick={() => void handleUpdateParty(party.id)}>
                                Save
                              </button>
                              <button className="btn" type="button" onClick={() => setEditingPartyId(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>,
                    );
                  }

                  return rows;
                })
              )}
            </DataTable>
          </Panel>
        </PanelGrid>
      </div>

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
