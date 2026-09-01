"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AdminMapSummary,
  AgentActivitySummary,
  AgentUserItem,
  AuthUserProfile,
  FieldTaskItem,
  FederalConstituencyItem,
  LgaItem,
  SenatorialDistrictItem,
  StateConstituencyItem,
  StateItem,
  WardItem,
} from "@pics-nigeria/shared";
import {
  ApiError,
  createAdminBulkTasks,
  createAdminTask,
  fetchAdminAgentActivitySummaries,
  fetchAdminMapSummary,
  fetchAdminTasks,
  fetchAgents,
  fetchCurrentUser,
  fetchFederalConstituencies,
  fetchLgas,
  fetchSenatorialDistricts,
  fetchStateConstituencies,
  fetchStates,
  fetchWards,
  logoutCurrentUser,
} from "../../../../lib/api";
import { AdminNav } from "../../../../components/admin-nav";
import { describeTerritory } from "../../../../components/admin-management-utils";
import { ConfirmDialog } from "../../../../components/confirm-dialog";
import { FeedbackBanner } from "../../../../components/feedback-banner";
import { GoogleLiveMap } from "../../../../components/google-live-map";
import { RasterLiveMap } from "../../../../components/raster-live-map";
import { clearSession, readSession } from "../../../../lib/session";

type Marker = {
  id: string;
  kind: "agent" | "incident";
  label: string;
  detail: string;
  timestamp: string | null;
  latitude: number;
  longitude: number;
};

function buildLiveMapMarkers(mapSummary: AdminMapSummary): Marker[] {
  const incidents = mapSummary.incidents
    .filter((incident) => incident.latitude !== null && incident.longitude !== null)
    .map((incident) => ({
      id: incident.id,
      kind: "incident" as const,
      label: incident.title,
      detail: `${incident.type} | ${incident.severity} | ${incident.status}`,
      timestamp: incident.createdAt,
      latitude: incident.latitude as number,
      longitude: incident.longitude as number,
    }));

  const agents = mapSummary.activeAgents
    .filter((agent) => agent.latestLatitude !== null && agent.latestLongitude !== null)
    .map((agent) => ({
      id: agent.agentUserId,
      kind: "agent" as const,
      label: agent.name,
      detail: `${agent.latestActivityType || "No recent activity"} | ${agent.pollingUnitId || "No polling unit"}`,
      timestamp: agent.latestActivityAt,
      latitude: agent.latestLatitude as number,
      longitude: agent.latestLongitude as number,
    }));

  return [...incidents, ...agents];
}

export default function AdminLiveOperationsPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [mapSummary, setMapSummary] = useState<AdminMapSummary | null>(null);
  const [activity, setActivity] = useState<AgentActivitySummary[]>([]);
  const [agents, setAgents] = useState<AgentUserItem[]>([]);
  const [tasks, setTasks] = useState<FieldTaskItem[]>([]);
  const [states, setStates] = useState<StateItem[]>([]);
  const [lgas, setLgas] = useState<LgaItem[]>([]);
  const [trackingLgas, setTrackingLgas] = useState<LgaItem[]>([]);
  const [wards, setWards] = useState<WardItem[]>([]);
  const [districts, setDistricts] = useState<SenatorialDistrictItem[]>([]);
  const [federalConstituencies, setFederalConstituencies] = useState<FederalConstituencyItem[]>([]);
  const [stateConstituencies, setStateConstituencies] = useState<StateConstituencyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [trackingFilter, setTrackingFilter] = useState({
    stateId: "",
    lgaId: "",
    wardId: "",
    agentUserId: "",
  });
  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    assignedToUserId: "",
    priority: "HIGH" as FieldTaskItem["priority"],
    dueAt: "",
  });
  const [bulkForm, setBulkForm] = useState({
    title: "",
    description: "",
    priority: "MEDIUM" as FieldTaskItem["priority"],
    dueAt: "",
    stateId: "",
    lgaId: "",
    senatorialDistrictId: "",
    federalConstituencyId: "",
    stateConstituencyId: "",
    selectedAgentIds: [] as string[],
  });

  async function refreshLiveSignals(token: string) {
    const [nextMapSummary, nextActivity] = await Promise.all([
      fetchAdminMapSummary(token),
      fetchAdminAgentActivitySummaries(token),
    ]);

    setMapSummary(nextMapSummary);
    setActivity(nextActivity);
  }

  async function loadPage(token: string) {
    const [currentUser, nextMapSummary, nextActivity, nextAgents, nextTasks] = await Promise.all([
      fetchCurrentUser(token),
      fetchAdminMapSummary(token),
      fetchAdminAgentActivitySummaries(token),
      fetchAgents(token),
      fetchAdminTasks(token),
    ]);

    if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
      throw new ApiError("This page is available to admins only.", 403);
    }

    setUser(currentUser);
    setMapSummary(nextMapSummary);
    setActivity(nextActivity);
    setAgents(nextAgents);
    setTasks(nextTasks);
    const nextStates = await fetchStates(token, currentUser.adminProfile?.geoPoliticalZoneId || undefined);
    setStates(nextStates);

    const params = new URLSearchParams(window.location.search);
    const nextAgentUserId = params.get("agentUserId") || "";
    setTrackingFilter({
      stateId: params.get("stateId") || currentUser.adminProfile?.stateId || "",
      lgaId: params.get("lgaId") || currentUser.adminProfile?.lgaId || "",
      wardId: params.get("wardId") || currentUser.adminProfile?.wardId || "",
      agentUserId: nextAgentUserId,
    });
    setTaskForm((current) => ({ ...current, assignedToUserId: nextAgentUserId }));
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    loadPage(token)
      .catch((caughtError) => {
        setError(caughtError instanceof Error ? caughtError.message : "Could not load live operations.");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const token = readSession();
    if (!token) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshLiveSignals(token).catch(() => {
        // Keep the existing live view visible if one refresh fails.
      });
    }, 30_000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const token = readSession();
    if (!token || !bulkForm.stateId) {
      setLgas([]);
      setWards([]);
      setDistricts([]);
      setFederalConstituencies([]);
      setStateConstituencies([]);
      return;
    }

    fetchLgas(token, bulkForm.stateId).then(setLgas).catch(() => setLgas([]));
    fetchSenatorialDistricts(token, bulkForm.stateId).then(setDistricts).catch(() => setDistricts([]));
    fetchStateConstituencies(token, bulkForm.stateId).then(setStateConstituencies).catch(() => setStateConstituencies([]));
  }, [bulkForm.stateId]);

  useEffect(() => {
    const token = readSession();
    if (!token || !trackingFilter.stateId || !trackingFilter.lgaId) {
      setWards([]);
      return;
    }

    fetchWards(token, trackingFilter.stateId, trackingFilter.lgaId).then(setWards).catch(() => setWards([]));
  }, [trackingFilter.lgaId, trackingFilter.stateId]);

  useEffect(() => {
    const token = readSession();
    if (!token || !trackingFilter.stateId) {
      setTrackingLgas([]);
      return;
    }

    fetchLgas(token, trackingFilter.stateId).then(setTrackingLgas).catch(() => setTrackingLgas([]));
  }, [trackingFilter.stateId]);

  useEffect(() => {
    const token = readSession();
    if (!token || !bulkForm.stateId) {
      setFederalConstituencies([]);
      return;
    }

    fetchFederalConstituencies(token, bulkForm.stateId, bulkForm.senatorialDistrictId || undefined)
      .then(setFederalConstituencies)
      .catch(() => setFederalConstituencies([]));
  }, [bulkForm.senatorialDistrictId, bulkForm.stateId]);

  const markers = useMemo(() => (mapSummary ? buildLiveMapMarkers(mapSummary) : []), [mapSummary]);

  const territoryFilteredAgents = useMemo(() => {
    return agents.filter((agent) => {
      if (trackingFilter.stateId && agent.territory.stateId !== trackingFilter.stateId) {
        return false;
      }
      if (trackingFilter.lgaId && agent.territory.lgaId !== trackingFilter.lgaId) {
        return false;
      }
      if (trackingFilter.wardId && agent.territory.wardId !== trackingFilter.wardId) {
        return false;
      }
      return true;
    });
  }, [agents, trackingFilter.lgaId, trackingFilter.stateId, trackingFilter.wardId]);

  const visibleAgentIds = useMemo(() => new Set(territoryFilteredAgents.map((agent) => agent.userId)), [territoryFilteredAgents]);

  const visibleActivity = useMemo(() => {
    const scoped = activity.filter((item) => visibleAgentIds.has(item.agentUserId));
    if (trackingFilter.agentUserId) {
      return scoped.filter((item) => item.agentUserId === trackingFilter.agentUserId);
    }
    return scoped;
  }, [activity, trackingFilter.agentUserId, visibleAgentIds]);

  const selectedAgent = useMemo(
    () => territoryFilteredAgents.find((agent) => agent.userId === trackingFilter.agentUserId) || null,
    [territoryFilteredAgents, trackingFilter.agentUserId],
  );

  const visibleMarkers = useMemo(() => {
    if (!trackingFilter.agentUserId) {
      return markers.filter((marker) => marker.kind !== "agent" || visibleAgentIds.has(marker.id));
    }

    return markers.filter((marker) => marker.kind === "agent" && marker.id === trackingFilter.agentUserId);
  }, [markers, trackingFilter.agentUserId, visibleAgentIds]);

  const filteredAgents = useMemo(() => {
    return agents.filter((agent) => {
      if (bulkForm.stateId && agent.territory.stateId !== bulkForm.stateId) {
        return false;
      }
      if (bulkForm.lgaId && agent.territory.lgaId !== bulkForm.lgaId) {
        return false;
      }
      if (bulkForm.senatorialDistrictId && agent.territory.senatorialDistrictId !== bulkForm.senatorialDistrictId) {
        return false;
      }
      if (bulkForm.federalConstituencyId && agent.territory.federalConstituencyId !== bulkForm.federalConstituencyId) {
        return false;
      }
      if (bulkForm.stateConstituencyId && agent.territory.stateConstituencyId !== bulkForm.stateConstituencyId) {
        return false;
      }
      return true;
    });
  }, [agents, bulkForm]);

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
    router.replace("/login");
  }

  async function handleSingleTaskSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      const result = await createAdminTask(token, {
        title: taskForm.title,
        description: taskForm.description,
        assignedToUserId: taskForm.assignedToUserId,
        priority: taskForm.priority,
        dueAt: taskForm.dueAt ? new Date(taskForm.dueAt).toISOString() : undefined,
      });
      setMessage(result.message);
      setTaskForm({
        title: "",
        description: "",
        assignedToUserId: trackingFilter.agentUserId || "",
        priority: "HIGH",
        dueAt: "",
      });
      await loadPage(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not assign the task.");
    }
  }

  async function submitBulkTaskAssignment() {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setBulkSubmitting(true);
      setError("");
      const result = await createAdminBulkTasks(token, {
        title: bulkForm.title,
        description: bulkForm.description,
        priority: bulkForm.priority,
        dueAt: bulkForm.dueAt ? new Date(bulkForm.dueAt).toISOString() : undefined,
        agentUserIds: bulkForm.selectedAgentIds.length ? bulkForm.selectedAgentIds : undefined,
        stateId: bulkForm.stateId || undefined,
        lgaId: bulkForm.lgaId || undefined,
        senatorialDistrictId: bulkForm.senatorialDistrictId || undefined,
        federalConstituencyId: bulkForm.federalConstituencyId || undefined,
        stateConstituencyId: bulkForm.stateConstituencyId || undefined,
      });
      setMessage(result.message);
      setBulkForm({
        title: "",
        description: "",
        priority: "MEDIUM",
        dueAt: "",
        stateId: "",
        lgaId: "",
        senatorialDistrictId: "",
        federalConstituencyId: "",
        stateConstituencyId: "",
        selectedAgentIds: [],
      });
      await loadPage(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not assign bulk tasks.");
    } finally {
      setBulkSubmitting(false);
      setBulkConfirmOpen(false);
    }
  }

  function handleBulkTaskSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBulkConfirmOpen(true);
  }

  if (loading) {
    return (
      <main className="shell">
        <section className="panel hero">
          <h1>Loading live operations...</h1>
        </section>
      </main>
    );
  }

  if (!user || !mapSummary) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load live operations</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/admin/dashboard">Return to admin overview</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Live operations</p>
        <h1>Agent tracking and tasking</h1>
        <p>Current authority: {describeTerritory(user.adminProfile || {
          geoPoliticalZoneId: null, stateId: null, senatorialDistrictId: null, federalConstituencyId: null, lgaId: null, wardId: null, stateConstituencyId: null, pollingUnitId: null,
        })}</p>
        <div className="action-row" style={{ marginTop: 12 }}>
          <button className="button secondary" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </div>
      </section>

      <AdminNav role={user?.role} />
      <FeedbackBanner tone="error" message={error} />
      <FeedbackBanner tone="success" message={message} />

      <section className="live-map-layout">
        <section className="panel card live-map-frame">
          <div className="section-head">
            <div>
              <h2>Live field map</h2>
              <p className="muted">Device GPS agent locations and incident points in your current scope. The map refreshes automatically.</p>
            </div>
            <span className="status-pill">{visibleMarkers.length} live points</span>
          </div>
          <div className="grid" style={{ marginBottom: 16, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <label className="field">
              <span>State</span>
              <select value={trackingFilter.stateId} onChange={(event) => setTrackingFilter((current) => ({
                ...current,
                stateId: event.target.value,
                lgaId: "",
                wardId: "",
                agentUserId: "",
              }))}>
                <option value="">All allowed states</option>
                {states.filter((item) => !user.adminProfile?.stateId || item.id === user.adminProfile.stateId).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>LGA</span>
              <select value={trackingFilter.lgaId} onChange={(event) => setTrackingFilter((current) => ({
                ...current,
                lgaId: event.target.value,
                wardId: "",
                agentUserId: "",
              }))} disabled={!trackingFilter.stateId}>
                <option value="">All allowed LGAs</option>
                {trackingLgas.filter((item) => !user.adminProfile?.lgaId || item.id === user.adminProfile.lgaId).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Ward</span>
              <select value={trackingFilter.wardId} onChange={(event) => setTrackingFilter((current) => ({
                ...current,
                wardId: event.target.value,
                agentUserId: "",
              }))} disabled={!trackingFilter.lgaId}>
                <option value="">All allowed wards</option>
                {wards.filter((item) => !user.adminProfile?.wardId || item.id === user.adminProfile.wardId).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Single agent</span>
              <select value={trackingFilter.agentUserId} onChange={(event) => {
                const nextAgentUserId = event.target.value;
                setTrackingFilter((current) => ({ ...current, agentUserId: nextAgentUserId }));
                setTaskForm((current) => ({ ...current, assignedToUserId: nextAgentUserId }));
              }}>
                <option value="">All agents in territory</option>
                {territoryFilteredAgents.map((agent) => (
                  <option key={agent.userId} value={agent.userId}>{agent.name}</option>
                ))}
              </select>
            </label>
          </div>
          <GoogleLiveMap
            points={visibleMarkers}
            emptyMessage="No live coordinates available for the current filter."
            fallback={
              <RasterLiveMap
                points={visibleMarkers}
                emptyMessage="No live coordinates available for the current filter."
              />
            }
          />
          <div className="live-map-legend">
            <span><span className="legend-dot agent" /> Agents</span>
            <span><span className="legend-dot incident" /> Incidents</span>
          </div>
        </section>

        <section className="live-map-side">
          <section className="panel card">
            <div className="section-head">
              <div>
                <h2>Recent agent signals</h2>
                <p className="muted">
                  {trackingFilter.agentUserId
                    ? "Single-agent activity feed."
                    : "Territory-scoped agent activity feed."}
                </p>
              </div>
              <span className="status-pill">{visibleActivity.length} visible</span>
            </div>
            {selectedAgent ? (
              <article className="reward-item" style={{ marginBottom: 16 }}>
                <strong>{selectedAgent.name}</strong>
                <p className="muted">{describeTerritory(selectedAgent.territory)}</p>
                <p>{visibleActivity[0]?.latestActivityType || "No recent activity recorded."}</p>
                <p className="muted">{visibleActivity[0]?.latestActivityAt ? new Date(visibleActivity[0].latestActivityAt).toLocaleString() : "No timestamp"}</p>
              </article>
            ) : null}
            <div className="reward-list">
              {visibleActivity.slice(0, 6).map((item) => (
                <article key={item.agentUserId} className="reward-item">
                  <strong>{item.name}</strong>
                  <p>{item.latestActivityType || "No recent activity"}</p>
                  <p className="muted">{item.latestActivityAt ? new Date(item.latestActivityAt).toLocaleString() : "No timestamp"}</p>
                </article>
              ))}
              {visibleActivity.length === 0 ? <p className="muted">No agent signals found for the selected territory or agent.</p> : null}
            </div>
          </section>
        </section>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <section className="panel card">
          <h2>Assign task to one agent</h2>
          <form className="form" onSubmit={handleSingleTaskSubmit}>
            <label className="field">
              <span>Task title</span>
              <input value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} required />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea rows={4} value={taskForm.description} onChange={(event) => setTaskForm({ ...taskForm, description: event.target.value })} required />
            </label>
            <label className="field">
              <span>Assign agent</span>
              <select value={taskForm.assignedToUserId} onChange={(event) => setTaskForm({ ...taskForm, assignedToUserId: event.target.value })} required>
                <option value="">Select agent</option>
                {territoryFilteredAgents.map((agent) => (
                  <option key={agent.userId} value={agent.userId}>{agent.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Priority</span>
              <select value={taskForm.priority} onChange={(event) => setTaskForm({ ...taskForm, priority: event.target.value as FieldTaskItem["priority"] })}>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </label>
            <label className="field">
              <span>Due at</span>
              <input type="datetime-local" value={taskForm.dueAt} onChange={(event) => setTaskForm({ ...taskForm, dueAt: event.target.value })} />
            </label>
            <button className="button" type="submit">Assign Task</button>
          </form>
        </section>

        <section className="panel card">
          <h2>Bulk task assignment</h2>
          <p className="muted">Target agents by LGA, senatorial district, federal constituency, state constituency, or selected agent list.</p>
          <form className="form" onSubmit={handleBulkTaskSubmit}>
            <label className="field">
              <span>Task title</span>
              <input value={bulkForm.title} onChange={(event) => setBulkForm({ ...bulkForm, title: event.target.value })} required />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea rows={4} value={bulkForm.description} onChange={(event) => setBulkForm({ ...bulkForm, description: event.target.value })} required />
            </label>
            <label className="field">
              <span>State</span>
              <select value={bulkForm.stateId} onChange={(event) => setBulkForm({ ...bulkForm, stateId: event.target.value, lgaId: "", senatorialDistrictId: "", federalConstituencyId: "", stateConstituencyId: "", selectedAgentIds: [] })}>
                <option value="">Any allowed state</option>
                {states.filter((item) => !user.adminProfile?.stateId || item.id === user.adminProfile.stateId).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>LGA</span>
              <select value={bulkForm.lgaId} onChange={(event) => setBulkForm({ ...bulkForm, lgaId: event.target.value, selectedAgentIds: [] })} disabled={!bulkForm.stateId}>
                <option value="">Any allowed LGA</option>
                {lgas.filter((item) => !user.adminProfile?.lgaId || item.id === user.adminProfile.lgaId).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Senatorial district</span>
              <select value={bulkForm.senatorialDistrictId} onChange={(event) => setBulkForm({ ...bulkForm, senatorialDistrictId: event.target.value, federalConstituencyId: "", selectedAgentIds: [] })} disabled={!bulkForm.stateId}>
                <option value="">Any allowed district</option>
                {districts.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Federal constituency</span>
              <select value={bulkForm.federalConstituencyId} onChange={(event) => setBulkForm({ ...bulkForm, federalConstituencyId: event.target.value, selectedAgentIds: [] })} disabled={!bulkForm.stateId}>
                <option value="">Any allowed constituency</option>
                {federalConstituencies.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>State constituency</span>
              <select value={bulkForm.stateConstituencyId} onChange={(event) => setBulkForm({ ...bulkForm, stateConstituencyId: event.target.value, selectedAgentIds: [] })} disabled={!bulkForm.stateId}>
                <option value="">Any allowed constituency</option>
                {stateConstituencies.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Priority</span>
              <select value={bulkForm.priority} onChange={(event) => setBulkForm({ ...bulkForm, priority: event.target.value as FieldTaskItem["priority"] })}>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </label>
            <label className="field">
              <span>Due at</span>
              <input type="datetime-local" value={bulkForm.dueAt} onChange={(event) => setBulkForm({ ...bulkForm, dueAt: event.target.value })} />
            </label>
            <div className="field">
              <span>Target agents preview</span>
              <div className="reward-list">
                {filteredAgents.slice(0, 8).map((agent) => {
                  const checked = bulkForm.selectedAgentIds.includes(agent.userId);
                  return (
                    <label key={agent.userId} className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setBulkForm((current) => ({
                            ...current,
                            selectedAgentIds: event.target.checked
                              ? [...current.selectedAgentIds, agent.userId]
                              : current.selectedAgentIds.filter((value) => value !== agent.userId),
                          }))
                        }
                      />
                      <span>{agent.name}</span>
                    </label>
                  );
                })}
                {filteredAgents.length === 0 ? <p className="muted">No scoped agents match the current target.</p> : null}
              </div>
            </div>
            <button className="button" type="submit">Assign Bulk Tasks</button>
          </form>
        </section>
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <h2>Recent assigned tasks</h2>
        {tasks.length === 0 ? (
          <p className="muted">No field tasks are currently visible in this scope.</p>
        ) : (
          <div className="reward-list">
            {tasks.slice(0, 8).map((task) => (
              <article key={task.id} className="reward-item">
                <strong>{task.title}</strong>
                <p>{task.description}</p>
                <p className="muted">{task.assigneeName} | {task.priority} | {task.status}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={bulkConfirmOpen}
        title="Assign bulk task"
        description={`Assign this task to ${bulkForm.selectedAgentIds.length || filteredAgents.length} agent${bulkForm.selectedAgentIds.length === 1 || (!bulkForm.selectedAgentIds.length && filteredAgents.length === 1) ? "" : "s"} in the current scoped target?`}
        confirmLabel="Assign task"
        onCancel={() => setBulkConfirmOpen(false)}
        onConfirm={() => void submitBulkTaskAssignment()}
        busy={bulkSubmitting}
      />
    </main>
  );
}
