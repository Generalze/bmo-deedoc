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
import {
  DataTable,
  DetailList,
  EmptyRow,
  Field,
  PageHead,
  Panel,
  PanelGrid,
  StateView,
  StatusPill,
  Toolbar,
  ToolbarField,
  formatCount,
} from "../../../../components/ui";
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
      <main className="console-shell">
        <PageHead title="Live operations" />
        <StateView kind="loading" title="Loading live operations…" />
      </main>
    );
  }

  if (!user || !mapSummary) {
    return (
      <main className="console-shell">
        <PageHead title="Live operations" />
        <StateView
          kind="error"
          title="Unable to load live operations"
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

  const bulkTargetCount = bulkForm.selectedAgentIds.length || filteredAgents.length;

  return (
    <main className="console-shell">
      <PageHead
        title="Agent tracking and tasking"
        lead={`Current authority: ${describeTerritory(
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
        actions={
          <button className="btn" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        }
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        <FeedbackBanner tone="error" message={error} />
        <FeedbackBanner tone="success" message={message} />

        <section className="workbench">
          <Panel
            title="Live field map"
            meta={`${formatCount(visibleMarkers.length)} live points`}
            flush
          >
            <Toolbar>
              <ToolbarField label="State">
                <select
                  value={trackingFilter.stateId}
                  onChange={(event) =>
                    setTrackingFilter((current) => ({
                      ...current,
                      stateId: event.target.value,
                      lgaId: "",
                      wardId: "",
                      agentUserId: "",
                    }))
                  }
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
              </ToolbarField>
              <ToolbarField label="LGA">
                <select
                  value={trackingFilter.lgaId}
                  onChange={(event) =>
                    setTrackingFilter((current) => ({
                      ...current,
                      lgaId: event.target.value,
                      wardId: "",
                      agentUserId: "",
                    }))
                  }
                  disabled={!trackingFilter.stateId}
                >
                  <option value="">All allowed LGAs</option>
                  {trackingLgas
                    .filter((item) => !user.adminProfile?.lgaId || item.id === user.adminProfile.lgaId)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </ToolbarField>
              <ToolbarField label="Ward">
                <select
                  value={trackingFilter.wardId}
                  onChange={(event) =>
                    setTrackingFilter((current) => ({ ...current, wardId: event.target.value, agentUserId: "" }))
                  }
                  disabled={!trackingFilter.lgaId}
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
              </ToolbarField>
              <ToolbarField label="Agent">
                <select
                  value={trackingFilter.agentUserId}
                  onChange={(event) => {
                    const nextAgentUserId = event.target.value;
                    setTrackingFilter((current) => ({ ...current, agentUserId: nextAgentUserId }));
                    setTaskForm((current) => ({ ...current, assignedToUserId: nextAgentUserId }));
                  }}
                >
                  <option value="">All agents in territory</option>
                  {territoryFilteredAgents.map((agent) => (
                    <option key={agent.userId} value={agent.userId}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </ToolbarField>
            </Toolbar>

            <div className="panel-body live-map-frame">
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
                <span>
                  <span className="legend-dot agent" /> Agents
                </span>
                <span>
                  <span className="legend-dot incident" /> Incidents
                </span>
              </div>
            </div>
          </Panel>

          <section className="live-map-side">
            <Panel
              title="Recent agent signals"
              meta={`${formatCount(visibleActivity.length)} visible`}
              flush
            >
              {selectedAgent ? (
                <div className="panel-body">
                  <DetailList
                    rows={[
                      { label: "Agent", value: <strong>{selectedAgent.name}</strong> },
                      { label: "Territory", value: describeTerritory(selectedAgent.territory) },
                      { label: "Latest", value: visibleActivity[0]?.latestActivityType || "No recent activity recorded." },
                      {
                        label: "When",
                        value: visibleActivity[0]?.latestActivityAt
                          ? new Date(visibleActivity[0].latestActivityAt).toLocaleString()
                          : "—",
                      },
                    ]}
                  />
                </div>
              ) : null}
              <DataTable
                head={
                  <tr>
                    <th>Agent</th>
                    <th>Latest activity</th>
                    <th>When</th>
                  </tr>
                }
              >
                {visibleActivity.length === 0 ? (
                  <EmptyRow colSpan={3}>No agent signals for the selected territory or agent.</EmptyRow>
                ) : (
                  visibleActivity.slice(0, 10).map((item) => (
                    <tr key={item.agentUserId}>
                      <td>{item.name}</td>
                      <td className="muted-text">{item.latestActivityType || "No recent activity"}</td>
                      <td className="muted-text">
                        {item.latestActivityAt ? new Date(item.latestActivityAt).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </DataTable>
            </Panel>
          </section>
        </section>

        <PanelGrid>
          <Panel title="Assign task to one agent">
            <form className="stack-3" onSubmit={handleSingleTaskSubmit}>
              <Field label="Task title">
                <input value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} required />
              </Field>
              <Field label="Description">
                <textarea
                  rows={4}
                  value={taskForm.description}
                  onChange={(event) => setTaskForm({ ...taskForm, description: event.target.value })}
                  required
                />
              </Field>
              <Field label="Assign agent">
                <select
                  value={taskForm.assignedToUserId}
                  onChange={(event) => setTaskForm({ ...taskForm, assignedToUserId: event.target.value })}
                  required
                >
                  <option value="">Select agent</option>
                  {territoryFilteredAgents.map((agent) => (
                    <option key={agent.userId} value={agent.userId}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="form-grid">
                <Field label="Priority">
                  <select
                    value={taskForm.priority}
                    onChange={(event) => setTaskForm({ ...taskForm, priority: event.target.value as FieldTaskItem["priority"] })}
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="CRITICAL">Critical</option>
                  </select>
                </Field>
                <Field label="Due at">
                  <input
                    type="datetime-local"
                    value={taskForm.dueAt}
                    onChange={(event) => setTaskForm({ ...taskForm, dueAt: event.target.value })}
                  />
                </Field>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" type="submit">
                  Assign task
                </button>
              </div>
            </form>
          </Panel>

          <Panel
            title="Bulk task assignment"
            meta={`${formatCount(bulkTargetCount)} agents targeted`}
          >
            <form className="stack-3" onSubmit={handleBulkTaskSubmit}>
              <p className="muted-text">
                Target agents by LGA, senatorial district, federal constituency, state constituency, or an explicit
                agent list.
              </p>
              <Field label="Task title">
                <input value={bulkForm.title} onChange={(event) => setBulkForm({ ...bulkForm, title: event.target.value })} required />
              </Field>
              <Field label="Description">
                <textarea
                  rows={4}
                  value={bulkForm.description}
                  onChange={(event) => setBulkForm({ ...bulkForm, description: event.target.value })}
                  required
                />
              </Field>
              <div className="form-grid">
                <Field label="State">
                  <select
                    value={bulkForm.stateId}
                    onChange={(event) =>
                      setBulkForm({
                        ...bulkForm,
                        stateId: event.target.value,
                        lgaId: "",
                        senatorialDistrictId: "",
                        federalConstituencyId: "",
                        stateConstituencyId: "",
                        selectedAgentIds: [],
                      })
                    }
                  >
                    <option value="">Any allowed state</option>
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
                    value={bulkForm.lgaId}
                    onChange={(event) => setBulkForm({ ...bulkForm, lgaId: event.target.value, selectedAgentIds: [] })}
                    disabled={!bulkForm.stateId}
                  >
                    <option value="">Any allowed LGA</option>
                    {lgas
                      .filter((item) => !user.adminProfile?.lgaId || item.id === user.adminProfile.lgaId)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Senatorial district">
                  <select
                    value={bulkForm.senatorialDistrictId}
                    onChange={(event) =>
                      setBulkForm({
                        ...bulkForm,
                        senatorialDistrictId: event.target.value,
                        federalConstituencyId: "",
                        selectedAgentIds: [],
                      })
                    }
                    disabled={!bulkForm.stateId}
                  >
                    <option value="">Any allowed district</option>
                    {districts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Federal constituency">
                  <select
                    value={bulkForm.federalConstituencyId}
                    onChange={(event) =>
                      setBulkForm({ ...bulkForm, federalConstituencyId: event.target.value, selectedAgentIds: [] })
                    }
                    disabled={!bulkForm.stateId}
                  >
                    <option value="">Any allowed constituency</option>
                    {federalConstituencies.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="State constituency">
                  <select
                    value={bulkForm.stateConstituencyId}
                    onChange={(event) =>
                      setBulkForm({ ...bulkForm, stateConstituencyId: event.target.value, selectedAgentIds: [] })
                    }
                    disabled={!bulkForm.stateId}
                  >
                    <option value="">Any allowed constituency</option>
                    {stateConstituencies.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Priority">
                  <select
                    value={bulkForm.priority}
                    onChange={(event) => setBulkForm({ ...bulkForm, priority: event.target.value as FieldTaskItem["priority"] })}
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="CRITICAL">Critical</option>
                  </select>
                </Field>
                <Field label="Due at">
                  <input
                    type="datetime-local"
                    value={bulkForm.dueAt}
                    onChange={(event) => setBulkForm({ ...bulkForm, dueAt: event.target.value })}
                  />
                </Field>
              </div>

              {/*
                Ticking nothing assigns to every agent the filters match, not to
                the handful shown. The count says so explicitly rather than
                leaving the preview to imply a smaller target than the action has.
              */}
              <Field
                label="Target agents"
                hint={
                  bulkForm.selectedAgentIds.length
                    ? `${formatCount(bulkForm.selectedAgentIds.length)} explicitly selected.`
                    : `No agent ticked, so the task goes to all ${formatCount(filteredAgents.length)} agents matching the filters above.`
                }
              >
                <div className="cluster" style={{ maxHeight: "12rem", overflowY: "auto" }}>
                  {filteredAgents.length === 0 ? (
                    <span className="muted-text">No scoped agents match the current target.</span>
                  ) : (
                    filteredAgents.map((agent) => (
                      <label key={agent.userId} className="cluster">
                        <input
                          type="checkbox"
                          checked={bulkForm.selectedAgentIds.includes(agent.userId)}
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
                    ))
                  )}
                </div>
              </Field>

              <div className="btn-row">
                <button className="btn btn-primary" type="submit">
                  Assign to {formatCount(bulkTargetCount)} agents
                </button>
              </div>
            </form>
          </Panel>
        </PanelGrid>

        <Panel title="Recent assigned tasks" meta={`${formatCount(tasks.length)} visible`} flush>
          <DataTable
            head={
              <tr>
                <th>Task</th>
                <th>Assignee</th>
                <th>Priority</th>
                <th>Status</th>
              </tr>
            }
          >
            {tasks.length === 0 ? (
              <EmptyRow colSpan={4}>No field tasks are visible in this scope.</EmptyRow>
            ) : (
              tasks.slice(0, 15).map((task) => (
                <tr key={task.id}>
                  <td>
                    <strong>{task.title}</strong>
                    {task.description ? <div className="muted-text">{task.description}</div> : null}
                  </td>
                  <td className="muted-text">{task.assigneeName}</td>
                  <td className="muted-text">{task.priority.toLowerCase()}</td>
                  <td>
                    <StatusPill status={task.status} />
                  </td>
                </tr>
              ))
            )}
          </DataTable>
        </Panel>
      </div>

      <ConfirmDialog
        open={bulkConfirmOpen}
        title="Assign bulk task"
        description={`Assign this task to ${bulkTargetCount} agent${bulkTargetCount === 1 ? "" : "s"} in the current scoped target?`}
        confirmLabel="Assign task"
        onCancel={() => setBulkConfirmOpen(false)}
        onConfirm={() => void submitBulkTaskAssignment()}
        busy={bulkSubmitting}
      />
    </main>
  );
}
