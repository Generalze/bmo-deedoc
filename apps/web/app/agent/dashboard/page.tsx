"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  type AuthUserProfile,
  type FieldTaskItem,
  type NotificationItem,
} from "@pics-nigeria/shared";
import {
  ApiError,
  createAgentActivity,
  createAgentIncident,
  fetchAgentActivities,
  fetchAgentTasks,
  fetchCurrentUser,
  fetchNotifications,
  logoutCurrentUser,
  updateAgentTask,
} from "../../../lib/api";
import { AGENT_TRACKING_EVENT_NAME } from "../../../components/agent-session-tracker";
import {
  DataTable,
  DetailList,
  EmptyRow,
  Field,
  Kpi,
  KpiRow,
  Notice,
  PageHead,
  Panel,
  PanelGrid,
  StateView,
  StatusPill,
  formatCount,
} from "../../../components/ui";
import { clearSession, readSession } from "../../../lib/session";

type AgentActivityItem = Awaited<ReturnType<typeof fetchAgentActivities>>[number];

export default function AgentDashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [activities, setActivities] = useState<AgentActivityItem[]>([]);
  const [tasks, setTasks] = useState<FieldTaskItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [gpsGateError, setGpsGateError] = useState("");
  const [activityMessage, setActivityMessage] = useState("");
  const [incidentMessage, setIncidentMessage] = useState("");
  const [locationPending, setLocationPending] = useState(false);
  const [trackerStatus, setTrackerStatus] = useState("Live tracking starts automatically while you are signed in.");
  const [lastPingAt, setLastPingAt] = useState("");
  const [incidentForm, setIncidentForm] = useState({
    type: "OTHER",
    title: "",
    description: "",
    severity: "MEDIUM",
    pollingUnitId: "",
    latitude: "",
    longitude: "",
  });
  async function loadAgentDashboard(token: string) {
    const [currentUser, recentActivities, taskItems, notificationItems] = await Promise.all([
      fetchCurrentUser(token),
      fetchAgentActivities(token),
      fetchAgentTasks(token),
      fetchNotifications(token),
    ]);

    const hasPollingUnitFieldAccess =
      currentUser.role === "AGENT" ||
      (currentUser.role === "COORDINATOR" && currentUser.coordinatorProfile?.level === "POLLING_UNIT" && currentUser.agentProfile);
    if (!hasPollingUnitFieldAccess) {
      throw new ApiError("This dashboard is available to Polling Unit field coordinators only.", 403);
    }

    setUser(currentUser);
    setActivities(recentActivities);
    setTasks(taskItems);
    setNotifications(notificationItems);
  }

  function requireGpsForDashboard() {
    return new Promise<void>((resolve, reject) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        reject(new Error("Device GPS is required for agent access."));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        () => resolve(),
        () => reject(new Error("Turn on device GPS and allow location access to access the agent dashboard.")),
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 20_000,
        },
      );
    });
  }

  async function handleTaskStatusUpdate(taskId: string, status: FieldTaskItem["status"]) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setError("");
      await updateAgentTask(token, taskId, { status });
      await loadAgentDashboard(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Task update failed.");
    }
  }

  useEffect(() => {
    const token = readSession();

    if (!token) {
      window.location.href = "/login?field=1";
      return;
    }

    requireGpsForDashboard()
      .then(() => loadAgentDashboard(token))
      .catch((caughtError) => {
        setGpsGateError(caughtError instanceof Error ? caughtError.message : "Device GPS is required.");
      })
      .finally(() => setLoading(false));
  }, []);

  function readCurrentPosition() {
    return new Promise<GeolocationPosition>((resolve, reject) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        reject(new Error("Device GPS is not available on this browser."));
        return;
      }

      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20_000,
      });
    });
  }

  async function forceLogout(reason?: string) {
    const token = readSession();
    if (token) {
      try {
        await logoutCurrentUser(token);
      } catch {
        // Best effort. The session may already be invalidated.
      }
    }

    clearSession();
    router.replace(reason ? `/login?field=1&reason=${encodeURIComponent(reason)}` : "/login?field=1");
  }

  async function sendDeviceLocation(path: "check-in" | "check-out" | "location", options?: { refreshDashboard?: boolean }) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    setError("");
    setLocationPending(true);

    try {
      const position = await readCurrentPosition();
      const result = (await createAgentActivity(token, path, {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : undefined,
      })) as { message?: string };

      const message =
        typeof result?.message === "string"
          ? result.message
          : path === "location"
            ? "Live location synced."
            : path === "check-in"
              ? "Check-in recorded."
              : "Check-out recorded.";

      if (path !== "location") {
        setActivityMessage(message);
      }

      if (options?.refreshDashboard) {
        await loadAgentDashboard(token);
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Location access failed.";
      if (path !== "location") {
        setError(message);
      }
    } finally {
      setLocationPending(false);
    }
  }

  async function handleActivity(path: "check-in" | "check-out") {
    setActivityMessage("");
    void sendDeviceLocation(path, { refreshDashboard: true });
  }

  async function handleSignOut() {
    await forceLogout();
  }

  useEffect(() => {
    function handleTrackingEvent(event: Event) {
      const customEvent = event as CustomEvent<{ active: boolean; status: string; lastPingAt?: string | null }>;
      setTrackerStatus(customEvent.detail.status);
      if (customEvent.detail.lastPingAt) {
        setLastPingAt(customEvent.detail.lastPingAt);
      }
    }

    if (typeof window === "undefined") {
      return;
    }

    window.addEventListener(AGENT_TRACKING_EVENT_NAME, handleTrackingEvent as EventListener);
    return () => window.removeEventListener(AGENT_TRACKING_EVENT_NAME, handleTrackingEvent as EventListener);
  }, []);

  async function handleIncidentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    setIncidentMessage("");
    try {
      await createAgentIncident(token, {
        type: incidentForm.type,
        title: incidentForm.title,
        description: incidentForm.description,
        severity: incidentForm.severity,
        pollingUnitId: incidentForm.pollingUnitId || undefined,
        latitude: incidentForm.latitude ? Number(incidentForm.latitude) : undefined,
        longitude: incidentForm.longitude ? Number(incidentForm.longitude) : undefined,
      });
      setIncidentMessage("Incident submitted.");
      setIncidentForm({
        type: "OTHER",
        title: "",
        description: "",
        severity: "MEDIUM",
        pollingUnitId: "",
        latitude: "",
        longitude: "",
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Incident submission failed.");
    }
  }
  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Field dashboard" />
        <StateView kind="loading" title="Preparing your field profile…" />
      </main>
    );
  }

  if (error || !user) {
    return (
      <main className="console-shell">
        <PageHead title="Field dashboard" />
        <StateView
          kind="error"
          title="Unable to load your dashboard"
          detail={gpsGateError || error || "Authentication is required."}
          action={
            <span className="btn-row">
              {gpsGateError ? (
                <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
                  Retry GPS check
                </button>
              ) : null}
              <Link className="btn" href="/login?field=1">
                Return to sign in
              </Link>
            </span>
          }
        />
      </main>
    );
  }

  const openTasks = tasks.filter((task) => task.status !== "DONE");

  return (
    <main className="console-shell">
      <PageHead
        title={user.name}
        lead="Field agent"
        actions={
          <>
            <Link className="btn btn-primary" href="/agent/election-report">
              Submit election report
            </Link>
            <button className="btn" type="button" onClick={() => void handleSignOut()}>
              Sign out
            </button>
          </>
        }
      />

      <div className="stack-4">
        <KpiRow>
          <Kpi
            label="Open tasks"
            value={formatCount(openTasks.length)}
            note={`${formatCount(tasks.length)} assigned in total`}
            tone={openTasks.length > 0 ? "accent" : undefined}
          />
          <Kpi label="Recent activity" value={formatCount(activities.length)} note="Records you have logged" />
          <Kpi
            label="Polling Unit"
            value={user.agentProfile?.pollingUnitId ? "Assigned" : "Not assigned"}
            note={user.agentProfile?.pollingUnitId || "Ask your coordinator to assign one"}
            tone={user.agentProfile?.pollingUnitId ? undefined : "warn"}
          />
        </KpiRow>

        <PanelGrid>
          <Panel title="Attendance">
            <div className="stack-3">
              <div className="btn-row">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void handleActivity("check-in")}
                  disabled={locationPending}
                >
                  {locationPending ? "Waiting for GPS…" : "Check in"}
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => void handleActivity("check-out")}
                  disabled={locationPending}
                >
                  {locationPending ? "Waiting for GPS…" : "Check out"}
                </button>
              </div>
              <p className="muted-text">
                Attendance uses device GPS coordinates rather than a typed location.
              </p>
              {activityMessage ? <Notice tone="ok" title={activityMessage} /> : null}
            </div>
          </Panel>

          <Panel title="Live tracking">
            <DetailList
              rows={[
                { label: "Status", value: trackerStatus || "Running for this session" },
                {
                  label: "Last ping",
                  value: lastPingAt ? new Date(lastPingAt).toLocaleString() : "No ping yet",
                },
                {
                  label: "Stops when",
                  value: "You sign out. Tracking runs automatically while signed in.",
                },
              ]}
            />
          </Panel>

          <Panel title="Assigned territory">
            {/* These are identifiers, not names — the agent profile carries IDs
                and this endpoint does not resolve them. Labelling them as IDs is
                honest; inventing names here would not be. */}
            <DetailList
              rows={[
                { label: "State ID", value: <span className="mono">{user.agentProfile?.stateId || "—"}</span> },
                { label: "LGA ID", value: <span className="mono">{user.agentProfile?.lgaId || "—"}</span> },
                { label: "Ward ID", value: <span className="mono">{user.agentProfile?.wardId || "—"}</span> },
                {
                  label: "Polling Unit ID",
                  value: <span className="mono">{user.agentProfile?.pollingUnitId || "Not assigned"}</span>,
                },
              ]}
            />
          </Panel>
        </PanelGrid>

        <Panel title="Report an incident">
          <form className="stack-3" onSubmit={handleIncidentSubmit}>
            <div className="form-grid">
              <Field label="Type">
                <select
                  value={incidentForm.type}
                  onChange={(event) => setIncidentForm({ ...incidentForm, type: event.target.value })}
                >
                  {INCIDENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type.replaceAll("_", " ").toLowerCase()}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Severity">
                <select
                  value={incidentForm.severity}
                  onChange={(event) => setIncidentForm({ ...incidentForm, severity: event.target.value })}
                >
                  {INCIDENT_SEVERITIES.map((severity) => (
                    <option key={severity} value={severity}>
                      {severity.toLowerCase()}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Title">
              <input
                value={incidentForm.title}
                onChange={(event) => setIncidentForm({ ...incidentForm, title: event.target.value })}
                required
              />
            </Field>
            <Field label="Description">
              <textarea
                rows={3}
                value={incidentForm.description}
                onChange={(event) => setIncidentForm({ ...incidentForm, description: event.target.value })}
                required
              />
            </Field>
            <Field label="Polling Unit" hint="Leave blank to use the Polling Unit you are assigned to.">
              <input
                value={incidentForm.pollingUnitId}
                onChange={(event) => setIncidentForm({ ...incidentForm, pollingUnitId: event.target.value })}
                placeholder={user.agentProfile?.pollingUnitId || "Assigned Polling Unit will be used"}
              />
            </Field>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Submit incident
              </button>
            </div>
            {incidentMessage ? <Notice tone="ok" title={incidentMessage} /> : null}
          </form>
        </Panel>

        <Panel title="Assigned tasks" meta={`${formatCount(openTasks.length)} open`}>
          {tasks.length === 0 ? (
            <StateView kind="empty" title="No tasks assigned yet" />
          ) : (
            /* Cards, not a table: this screen is used one-handed on a phone in
               the field, where a horizontally scrolling table is unusable. */
            <div className="stack-3">
              {tasks.map((task) => (
                <article key={task.id} className="kpi">
                  <div className="split">
                    <strong>{task.title}</strong>
                    <span className="split-end">
                      <StatusPill status={task.status} />
                    </span>
                  </div>
                  <p className="muted-text">{task.description}</p>
                  <p className="muted-text">
                    {task.priority.toLowerCase()} · created by {task.creatorName} · due{" "}
                    {task.dueAt ? new Date(task.dueAt).toLocaleString() : "not set"}
                  </p>
                  <div className="btn-row">
                    <button className="btn btn-sm" type="button" onClick={() => void handleTaskStatusUpdate(task.id, "IN_PROGRESS")}>
                      Start
                    </button>
                    <button className="btn btn-sm" type="button" onClick={() => void handleTaskStatusUpdate(task.id, "BLOCKED")}>
                      Block
                    </button>
                    <button
                      className="btn btn-sm btn-primary"
                      type="button"
                      onClick={() => void handleTaskStatusUpdate(task.id, "DONE")}
                    >
                      Complete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <PanelGrid>
          <Panel title="Your recent activity" flush>
            <DataTable
              head={
                <tr>
                  <th>Type</th>
                  <th>Note</th>
                  <th>When</th>
                </tr>
              }
            >
              {activities.length === 0 ? (
                <EmptyRow colSpan={3}>No activity recorded yet.</EmptyRow>
              ) : (
                activities.map((activity) => (
                  <tr key={activity.id}>
                    <td>{activity.type.replace(/_/g, " ").toLowerCase()}</td>
                    <td className="muted-text">{activity.note || "No note"}</td>
                    <td className="muted-text">{new Date(activity.createdAt).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>

          <Panel title="Notifications">
            {notifications.length === 0 ? (
              <StateView kind="empty" title="No notifications yet" />
            ) : (
              <ul className="stack-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {notifications.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    <p className="muted-text">{item.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </PanelGrid>
      </div>
    </main>
  );
}
