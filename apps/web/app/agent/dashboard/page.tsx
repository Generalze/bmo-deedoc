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
      <main className="shell">
        <section className="panel hero">
          <h1>Loading agent dashboard...</h1>
          <p>Please wait while your field profile is prepared.</p>
        </section>
      </main>
    );
  }

  if (error || !user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load dashboard</h1>
          <p className="error">{gpsGateError || error || "Authentication is required."}</p>
          {gpsGateError ? (
            <p>
              <button className="button" type="button" onClick={() => window.location.reload()}>
                Retry GPS check
              </button>
            </p>
          ) : null}
          <p>
            <Link href="/login?field=1">Return to sign in</Link>
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <h1>{user.name}</h1>
        <p>
          Assigned territory: <strong>{user.agentProfile?.stateId}</strong> | {user.agentProfile?.lgaId} |{" "}
          {user.agentProfile?.wardId}
        </p>
        <p className="muted">Polling unit: {user.agentProfile?.pollingUnitId || "Not assigned"}</p>
        <div className="action-row" style={{ marginTop: 12 }}>
          <Link href="/agent/election-report" className="button">
            Submit Election Report
          </Link>
          <button className="button secondary" type="button" onClick={() => void handleSignOut()}>
            Sign out
          </button>
        </div>
      </section>

      <section className="grid stats">
        <article className="panel card">
          <h2>Recent Activity</h2>
          <div className="value">{activities.length}</div>
        </article>
        <article className="panel card">
          <h2>Open Tasks</h2>
          <div className="value">{tasks.filter((task) => task.status !== "DONE").length}</div>
        </article>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <section className="panel card">
          <h2>Attendance</h2>
          <div className="action-row">
            <button className="button" type="button" onClick={() => void handleActivity("check-in")} disabled={locationPending}>
              {locationPending ? "Waiting for GPS..." : "Check in"}
            </button>
            <button className="button secondary" type="button" onClick={() => void handleActivity("check-out")} disabled={locationPending}>
              {locationPending ? "Waiting for GPS..." : "Check out"}
            </button>
          </div>
          <p className="muted">Attendance records now use device GPS coordinates instead of typed location values.</p>
          {activityMessage ? <p className="muted">{activityMessage}</p> : null}
        </section>

        <section className="panel card">
          <h2>Live Tracking</h2>
          <p className="muted">Device GPS tracking runs automatically for your session and stops only when you sign out.</p>
          {trackerStatus ? <p className="muted">{trackerStatus}</p> : null}
          {lastPingAt ? <p className="muted">Last live ping: {new Date(lastPingAt).toLocaleString()}</p> : null}
        </section>
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <h2>Quick Incident Submission</h2>
          <form className="form" onSubmit={handleIncidentSubmit}>
            <label className="field">
              <span>Type</span>
              <select value={incidentForm.type} onChange={(event) => setIncidentForm({ ...incidentForm, type: event.target.value })}>
                {INCIDENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          <label className="field">
            <span>Title</span>
            <input value={incidentForm.title} onChange={(event) => setIncidentForm({ ...incidentForm, title: event.target.value })} required />
          </label>
          <label className="field">
            <span>Description</span>
            <input value={incidentForm.description} onChange={(event) => setIncidentForm({ ...incidentForm, description: event.target.value })} required />
          </label>
            <label className="field">
              <span>Severity</span>
              <select value={incidentForm.severity} onChange={(event) => setIncidentForm({ ...incidentForm, severity: event.target.value })}>
                {INCIDENT_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Polling Unit</span>
              <input
                value={incidentForm.pollingUnitId}
                onChange={(event) => setIncidentForm({ ...incidentForm, pollingUnitId: event.target.value })}
                placeholder={user.agentProfile?.pollingUnitId || "Assigned polling unit will be used"}
              />
            </label>
          <button className="button" type="submit">Submit incident</button>
        </form>
        {incidentMessage ? <p className="muted">{incidentMessage}</p> : null}
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <h2>Assigned Tasks</h2>
        {tasks.length === 0 ? (
          <p className="muted">No tasks assigned yet.</p>
        ) : (
          <div className="reward-list">
            {tasks.map((task) => (
              <article key={task.id} className="reward-item">
                <div className="section-head compact">
                  <div>
                    <strong>{task.title}</strong>
                    <p className="muted">{task.priority} | {task.status}</p>
                  </div>
                  <span className={`status-pill ${task.status === "DONE" ? "active" : task.status === "BLOCKED" ? "inactive" : ""}`}>{task.status}</span>
                </div>
                <p>{task.description}</p>
                <p className="muted">
                  Created by {task.creatorName} | Due {task.dueAt ? new Date(task.dueAt).toLocaleString() : "not set"}
                </p>
                <div className="action-row">
                  <button className="button secondary" type="button" onClick={() => void handleTaskStatusUpdate(task.id, "IN_PROGRESS")}>Start</button>
                  <button className="button secondary" type="button" onClick={() => void handleTaskStatusUpdate(task.id, "BLOCKED")}>Block</button>
                  <button className="button" type="button" onClick={() => void handleTaskStatusUpdate(task.id, "DONE")}>Complete</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <h2>Recent Own Activity</h2>
        {activities.length === 0 ? (
          <p className="muted">No activity recorded yet.</p>
        ) : (
          <div className="reward-list">
            {activities.map((activity) => (
              <article key={activity.id} className="reward-item">
                <strong>{activity.type}</strong>
                <p>{activity.note || "No note"}</p>
                <p className="muted">{new Date(activity.createdAt).toLocaleString()}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <h2>Notifications</h2>
        {notifications.length === 0 ? (
          <p className="muted">No notifications yet.</p>
        ) : (
          <div className="reward-list">
            {notifications.slice(0, 5).map((item) => (
              <article key={item.id} className="reward-item">
                <strong>{item.title}</strong>
                <p>{item.message}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
