"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AuthUserProfile,
  ElectionDayConversationItem,
  ElectionDayMessageItem,
  ElectionDayOperationalAlertItem,
  ElectionDayPollingUnitStatus,
  ElectionDaySituationRoomStatus,
  ElectionDayTimelineItem,
  ElectionDayWebrtcConfig,
} from "@pics-nigeria/shared";
import {
  ApiError,
  createElectionDayConversation,
  createElectionDayMessage,
  fetchCurrentUser,
  fetchElectionDayAlerts,
  fetchElectionDayConversations,
  fetchElectionDayMessages,
  fetchElectionDaySituationRoomStatus,
  fetchElectionDayTimeline,
  fetchElectionDayWebrtcConfig,
  reconcileElectionDayAlerts,
  updateElectionDayAlert,
} from "../../../lib/api";
import { FeedbackBanner } from "../../../components/feedback-banner";
import { VoiceCallPanel } from "../../../components/voice-call-panel";
import { readSession } from "../../../lib/session";


function pct(value: number) {
  return `${Math.max(0, Math.min(100, value))}%`;
}

function statusTone(status: string) {
  if (["COMPLETED", "RESOLVED", "APPROVED", "ONLINE"].includes(status)) {
    return "active";
  }
  if (["OPEN", "CRITICAL", "NO_CHECK_IN", "REPORT_OVERDUE", "LOCATION_STALE", "OFFLINE"].includes(status)) {
    return "inactive";
  }
  return "";
}

function conversationTitle(conversation: ElectionDayConversationItem, currentUserId: string) {
  if (conversation.title) {
    return conversation.title;
  }
  const otherMembers = conversation.members.filter((member) => member.userId !== currentUserId);
  return otherMembers.map((member) => member.name).join(", ") || "Election Operations Chat";
}

export default function ElectionSituationRoomPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  // Read once on mount: the panel needs a stable token, and localStorage is not
  // available during server rendering.
  const [callToken, setCallToken] = useState<string | null>(null);
  const [status, setStatus] = useState<ElectionDaySituationRoomStatus | null>(null);
  const [alerts, setAlerts] = useState<ElectionDayOperationalAlertItem[]>([]);
  const [timeline, setTimeline] = useState<ElectionDayTimelineItem[]>([]);
  const [conversations, setConversations] = useState<ElectionDayConversationItem[]>([]);
  const [messages, setMessages] = useState<ElectionDayMessageItem[]>([]);
  const [webrtc, setWebrtc] = useState<ElectionDayWebrtcConfig | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedPollingUnit, setSelectedPollingUnit] = useState<ElectionDayPollingUnitStatus | null>(null);
  const [reportDate, setReportDate] = useState(new Date().toISOString().slice(0, 10));
  const [messageDraft, setMessageDraft] = useState("");
  const [territoryChatTitle, setTerritoryChatTitle] = useState("Election Operations Chat");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "info"; message: string }>({ tone: "info", message: "" });

  async function loadPage(token: string, date = reportDate) {
    const [currentUser, nextStatus, nextAlerts, nextTimeline, nextConversations, nextWebrtc] = await Promise.all([
      fetchCurrentUser(token),
      fetchElectionDaySituationRoomStatus(token, date),
      fetchElectionDayAlerts(token, { reportDate: date }),
      fetchElectionDayTimeline(token, { reportDate: date, limit: 80 }),
      fetchElectionDayConversations(token),
      fetchElectionDayWebrtcConfig(token),
    ]);

    const canUseSituationRoom =
      currentUser.role === "SUPER_ADMIN" ||
      currentUser.role === "STATE_OFFICER" ||
      (currentUser.role === "COORDINATOR" && currentUser.coordinatorProfile);
    if (!canUseSituationRoom) {
      throw new ApiError("Election Situation Room requires a command-scope account.", 403);
    }

    setUser(currentUser);
    setStatus(nextStatus);
    setAlerts(nextAlerts);
    setTimeline(nextTimeline);
    setConversations(nextConversations);
    setWebrtc(nextWebrtc);
    setSelectedConversationId((current) => current || nextConversations[0]?.id || "");
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }
    setCallToken(token);

    loadPage(token)
      .catch((caughtError) => {
        setFeedback({ tone: "error", message: caughtError instanceof Error ? caughtError.message : "Could not load Situation Room." });
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const token = readSession();
    if (!token) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void loadPage(token).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(intervalId);
  }, [reportDate]);

  useEffect(() => {
    const token = readSession();
    if (!token || !selectedConversationId) {
      setMessages([]);
      return;
    }
    fetchElectionDayMessages(token, selectedConversationId)
      .then(setMessages)
      .catch(() => setMessages([]));
  }, [selectedConversationId]);

  const criticalAlerts = useMemo(() => alerts.filter((alert) => alert.status !== "RESOLVED" && alert.severity === "CRITICAL"), [alerts]);
  const activeAlerts = useMemo(() => alerts.filter((alert) => alert.status !== "RESOLVED"), [alerts]);
  const staleUnits = useMemo(() => status?.pollingUnits.filter((unit) => unit.lastSeenAt && Date.now() - new Date(unit.lastSeenAt).getTime() > 45 * 60_000) || [], [status]);
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) || null,
    [conversations, selectedConversationId],
  );

  async function refreshFromAction(message: string) {
    const token = readSession();
    if (!token) {
      return;
    }
    await loadPage(token);
    setFeedback({ tone: "success", message });
  }

  async function handleReconcileAlerts() {
    const token = readSession();
    if (!token) {
      setFeedback({ tone: "error", message: "Authentication is required." });
      return;
    }
    try {
      setBusy(true);
      const result = await reconcileElectionDayAlerts(token, { reportDate });
      await refreshFromAction(result.message);
    } catch (caughtError) {
      setFeedback({ tone: "error", message: caughtError instanceof Error ? caughtError.message : "Could not reconcile alerts." });
    } finally {
      setBusy(false);
    }
  }

  async function handleAlertStatus(alertId: string, nextStatus: "ACKNOWLEDGED" | "ESCALATED" | "RESOLVED") {
    const token = readSession();
    if (!token) {
      setFeedback({ tone: "error", message: "Authentication is required." });
      return;
    }
    try {
      setBusy(true);
      const result = await updateElectionDayAlert(token, alertId, { status: nextStatus });
      await refreshFromAction(result.message);
    } catch (caughtError) {
      setFeedback({ tone: "error", message: caughtError instanceof Error ? caughtError.message : "Could not update alert." });
    } finally {
      setBusy(false);
    }
  }

  async function openDirectChat(unit: ElectionDayPollingUnitStatus) {
    const token = readSession();
    if (!token || !unit.coordinatorUserId) {
      setFeedback({ tone: "error", message: "This Polling Unit has no assigned coordinator to message." });
      return;
    }
    try {
      setBusy(true);
      const result = await createElectionDayConversation(token, {
        type: "DIRECT",
        recipientUserId: unit.coordinatorUserId,
        title: `PU ${unit.pollingUnitName || unit.pollingUnitId}`,
      });
      setSelectedConversationId(result.conversationId);
      await refreshFromAction("Direct operational chat opened.");
    } catch (caughtError) {
      setFeedback({ tone: "error", message: caughtError instanceof Error ? caughtError.message : "Could not open direct chat." });
    } finally {
      setBusy(false);
    }
  }

  async function requestCheckIn(unit: ElectionDayPollingUnitStatus) {
    const token = readSession();
    if (!token || !unit.coordinatorUserId) {
      setFeedback({ tone: "error", message: "This Polling Unit has no assigned coordinator to message." });
      return;
    }
    try {
      setBusy(true);
      const conversation = await createElectionDayConversation(token, {
        type: "DIRECT",
        recipientUserId: unit.coordinatorUserId,
        title: `Check-in request: ${unit.pollingUnitName || unit.pollingUnitId}`,
      });
      await createElectionDayMessage(token, conversation.conversationId, {
        body: `Please confirm Election Day check-in and live status for ${unit.pollingUnitName || unit.pollingUnitId}.`,
        metadata: { quickAction: "REQUEST_CHECK_IN", pollingUnitId: unit.pollingUnitId },
      });
      setSelectedConversationId(conversation.conversationId);
      await refreshFromAction("Check-in request sent.");
    } catch (caughtError) {
      setFeedback({ tone: "error", message: caughtError instanceof Error ? caughtError.message : "Could not send check-in request." });
    } finally {
      setBusy(false);
    }
  }

  async function createTerritoryChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token || !status) {
      setFeedback({ tone: "error", message: "Authentication is required." });
      return;
    }
    try {
      setBusy(true);
      const result = await createElectionDayConversation(token, {
        type: "ELECTION_OPERATION",
        title: territoryChatTitle,
        territory: status.territory,
      });
      setSelectedConversationId(result.conversationId);
      await refreshFromAction("Election Operations Chat opened for this command scope.");
    } catch (caughtError) {
      setFeedback({ tone: "error", message: caughtError instanceof Error ? caughtError.message : "Could not create operations chat." });
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token || !selectedConversationId || !messageDraft.trim()) {
      return;
    }
    try {
      setBusy(true);
      const result = await createElectionDayMessage(token, selectedConversationId, { body: messageDraft });
      setMessages((current) => [...current, result.item]);
      setMessageDraft("");
      await refreshFromAction("Message sent.");
    } catch (caughtError) {
      setFeedback({ tone: "error", message: caughtError instanceof Error ? caughtError.message : "Could not send message." });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="shell">
        <section className="panel hero">
          <p className="eyebrow">Election Day</p>
          <h1>Loading Situation Room...</h1>
        </section>
      </main>
    );
  }

  if (!user || !status) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load Situation Room</h1>
          <FeedbackBanner tone={feedback.tone} message={feedback.message || "Authentication is required."} />
          <Link href="/">Return home</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell situation-room">
      <section className="panel hero situation-hero">
        <p className="eyebrow">Election Day Situation Room</p>
        <h1>Live command board for Ogun operations</h1>
        <p>
          Realtime status: {status.realtime.runtimeStatus}. REST fallback is {status.realtime.restFallbackAvailable ? "available" : "unavailable"}.
        </p>
        <div className="action-row" style={{ marginTop: 12 }}>
          <label className="field compact-field">
            <span>Operating date</span>
            <input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
          </label>
          <button className="button" type="button" disabled={busy} onClick={() => void loadPage(readSession() || "", reportDate)}>
            Refresh
          </button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => void handleReconcileAlerts()}>
            Reconcile Alerts
          </button>
          <Link className="button secondary" href="/agent/election-report">Submit Report</Link>
        </div>
      </section>

      <FeedbackBanner tone={feedback.tone} message={feedback.message} />

      <section className="grid stats situation-stats">
        <article className="panel card">
          <h2>Expected PUs</h2>
          <div className="value">{status.totals.expectedPollingUnits}</div>
        </article>
        <article className="panel card">
          <h2>Checked In</h2>
          <div className="value">{status.totals.checkedInPollingUnits}</div>
        </article>
        <article className="panel card">
          <h2>Reports</h2>
          <div className="value">{pct(status.totals.reportingPercentage)}</div>
        </article>
        <article className="panel card">
          <h2>Open Alerts</h2>
          <div className="value">{activeAlerts.length}</div>
        </article>
        <article className="panel card">
          <h2>Critical Incidents</h2>
          <div className="value">{status.totals.criticalIncidents}</div>
        </article>
        <article className="panel card">
          <h2>Stale Tracking</h2>
          <div className="value">{staleUnits.length}</div>
        </article>
      </section>

      <section className="situation-grid">
        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Polling Unit operational status</h2>
              <p className="muted">Hierarchical status is scoped by backend authorization. Geofence validation remains gated by authoritative PU geodata.</p>
            </div>
            <span className="status-pill">{status.pollingUnits.length} visible</span>
          </div>
          <div className="operation-board">
            {status.pollingUnits.slice(0, 80).map((unit) => (
              <button
                key={unit.pollingUnitId}
                type="button"
                className={`operation-unit ${selectedPollingUnit?.pollingUnitId === unit.pollingUnitId ? "selected" : ""}`}
                onClick={() => setSelectedPollingUnit(unit)}
              >
                <strong>{unit.pollingUnitName || unit.pollingUnitId}</strong>
                <span className={`status-pill ${statusTone(unit.operationalStatus)}`}>{unit.operationalStatus}</span>
                <span>{unit.coordinatorName || "No coordinator"}</span>
                <span className="muted">Report: {unit.reportStatus} | Incidents: {unit.openIncidentCount}</span>
              </button>
            ))}
            {status.pollingUnits.length === 0 ? <p className="muted">No Polling Units are visible in this command scope.</p> : null}
          </div>
        </section>

        <aside className="panel card">
          <h2>Quick controls</h2>
          {selectedPollingUnit ? (
            <div className="reward-list">
              <article className="reward-item">
                <strong>{selectedPollingUnit.pollingUnitName || selectedPollingUnit.pollingUnitId}</strong>
                <p>{selectedPollingUnit.coordinatorName || "No assigned coordinator"}</p>
                <p className="muted">
                  Last seen: {selectedPollingUnit.lastSeenAt ? new Date(selectedPollingUnit.lastSeenAt).toLocaleString() : "No tracking signal"}
                </p>
                <p className="muted">Geofence: {selectedPollingUnit.geofence.status}</p>
                <div className="action-row">
                  <button className="button secondary" type="button" disabled={busy || !selectedPollingUnit.coordinatorUserId} onClick={() => void openDirectChat(selectedPollingUnit)}>
                    Message
                  </button>
                  <button className="button secondary" type="button" disabled={busy || !selectedPollingUnit.coordinatorUserId} onClick={() => void requestCheckIn(selectedPollingUnit)}>
                    Request Check-In
                  </button>
                  <Link className="button secondary" href="/admin/election-reports">View Reports</Link>
                </div>
              </article>
            </div>
          ) : (
            <p className="muted">Select a Polling Unit to message, request check-in, or inspect status.</p>
          )}
          <form className="form" style={{ marginTop: 16 }} onSubmit={createTerritoryChat}>
            <label className="field">
              <span>Operations chat title</span>
              <input value={territoryChatTitle} onChange={(event) => setTerritoryChatTitle(event.target.value)} />
            </label>
            <button className="button" type="submit" disabled={busy}>Open Territory Chat</button>
          </form>
          <div className="webrtc-card">
            <strong>Voice foundation</strong>
            <p className="muted">
              STUN entries: {webrtc?.iceServers.length || 0}. TURN: {webrtc?.turnConfigured ? "configured" : "not configured"}. Recording: disabled.
            </p>
            <p className="muted">Durable call history is blocked pending schema review.</p>
          </div>
        </aside>
      </section>

      <section className="situation-grid secondary-grid">
        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Operational alerts</h2>
              <p className="muted">Lifecycle actions are audited and broadcast through the durable outbox.</p>
            </div>
            <span className={`status-pill ${criticalAlerts.length ? "inactive" : "active"}`}>{criticalAlerts.length} critical</span>
          </div>
          <div className="reward-list">
            {alerts.slice(0, 12).map((alert) => (
              <article key={alert.id} className="reward-item">
                <div className="section-head compact">
                  <div>
                    <strong>{alert.type.replaceAll("_", " ")}</strong>
                    <p>{alert.message}</p>
                    <p className="muted">{new Date(alert.detectedAt).toLocaleString()} | {alert.territory.pollingUnitId || "territory"}</p>
                  </div>
                  <span className={`status-pill ${statusTone(alert.status)}`}>{alert.status}</span>
                </div>
                <div className="action-row">
                  <button className="button secondary" type="button" disabled={busy || alert.status === "ACKNOWLEDGED"} onClick={() => void handleAlertStatus(alert.id, "ACKNOWLEDGED")}>Acknowledge</button>
                  <button className="button secondary" type="button" disabled={busy || alert.status === "ESCALATED"} onClick={() => void handleAlertStatus(alert.id, "ESCALATED")}>Escalate</button>
                  <button className="button" type="button" disabled={busy || alert.status === "RESOLVED"} onClick={() => void handleAlertStatus(alert.id, "RESOLVED")}>Resolve</button>
                </div>
              </article>
            ))}
            {alerts.length === 0 ? <p className="muted">No durable alerts for this date. Use Reconcile Alerts to create missing check-in, overdue report, and stale tracking alerts.</p> : null}
          </div>
        </section>

        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Election Operations Chat</h2>
              <p className="muted">Direct, group, and territory conversations are permission-scoped and durable.</p>
            </div>
            <span className="status-pill">{conversations.length} chats</span>
          </div>
          <div className="chat-layout">
            <div className="conversation-list">
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  className={`conversation-button ${conversation.id === selectedConversationId ? "selected" : ""}`}
                  onClick={() => setSelectedConversationId(conversation.id)}
                >
                  <strong>{conversationTitle(conversation, user.id)}</strong>
                  <span>{conversation.type} | {conversation.members.length} members</span>
                  <span>{conversation.unreadCount} unread</span>
                </button>
              ))}
              {conversations.length === 0 ? <p className="muted">No conversations yet. Open a territory chat or select a PU to message.</p> : null}
            </div>
            <div className="message-pane">
              <strong>{selectedConversation ? conversationTitle(selectedConversation, user.id) : "No conversation selected"}</strong>
              <div className="message-list">
                {messages.map((message) => (
                  <article key={message.id} className={`message-bubble ${message.senderUserId === user.id ? "own" : ""}`}>
                    <strong>{message.senderName}</strong>
                    <p>{message.body}</p>
                    <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                  </article>
                ))}
                {selectedConversation && messages.length === 0 ? <p className="muted">No messages in this conversation yet.</p> : null}
              </div>
              <form className="message-form" onSubmit={sendMessage}>
                <input
                  value={messageDraft}
                  onChange={(event) => setMessageDraft(event.target.value)}
                  placeholder="Send an operational update..."
                  disabled={!selectedConversationId}
                />
                <button className="button" type="submit" disabled={busy || !selectedConversationId || !messageDraft.trim()}>Send</button>
              </form>
            </div>
          </div>
        </section>
      </section>

      {callToken ? (
        <section className="panel card" style={{ marginTop: 24 }}>
          {/* Callable contacts are the people already in this officer's
              conversations, which the API has authorized for contact. */}
          <VoiceCallPanel
            token={callToken}
            contacts={conversations
              .flatMap((conversation) => conversation.members)
              .filter((member) => member.userId !== user?.id)
              .filter((member, index, all) => all.findIndex((item) => item.userId === member.userId) === index)
              .map((member) => ({ userId: member.userId, name: member.name, role: member.role }))}
          />
        </section>
      ) : null}

      <section className="panel card" style={{ marginTop: 24 }}>
        <div className="section-head">
          <div>
            <h2>Operational timeline</h2>
            <p className="muted">Reports, alerts, incidents, messages, field activity, and durable realtime outbox events.</p>
          </div>
          <span className="status-pill">{timeline.length} events</span>
        </div>
        <div className="timeline-list">
          {timeline.map((item) => (
            <article key={`${item.type}-${item.id}`} className="timeline-item">
              <span className={`timeline-dot ${item.severity === "CRITICAL" ? "critical" : ""}`} />
              <div>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
                <p className="muted">{item.type} | {new Date(item.occurredAt).toLocaleString()} | {item.pollingUnitId || "territory"}</p>
              </div>
            </article>
          ))}
          {timeline.length === 0 ? <p className="muted">No timeline events for this date.</p> : null}
        </div>
      </section>
    </main>
  );
}
