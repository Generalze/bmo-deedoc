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
import {
  DataTable,
  DetailList,
  EmptyRow,
  Field,
  Kpi,
  KpiRow,
  PageHead,
  Panel,
  StateView,
  formatCount,
} from "../../../components/ui";
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
      <main className="console-shell">
        <PageHead title="Election Day Situation Room" />
        <StateView kind="loading" title="Loading the Situation Room…" />
      </main>
    );
  }

  if (!user || !status) {
    return (
      <main className="console-shell">
        <PageHead title="Election Day Situation Room" />
        <StateView
          kind="error"
          title="Unable to load the Situation Room"
          detail={feedback.message || "Authentication is required."}
          action={
            <Link className="btn btn-primary" href="/">
              Return home
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <main className="console-shell situation-room">
      <PageHead
        title="Live command board for Ogun operations"
        lead={`Realtime status: ${status.realtime.runtimeStatus}. REST fallback is ${
          status.realtime.restFallbackAvailable ? "available" : "unavailable"
        }.`}
        actions={
          <>
            <label className="cluster">
              <span className="kpi-label">Operating date</span>
              <input type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
            </label>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => void loadPage(readSession() || "", reportDate)}
            >
              Refresh
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void handleReconcileAlerts()}>
              Reconcile alerts
            </button>
            <Link className="btn" href="/agent/election-report">
              Submit report
            </Link>
          </>
        }
      />

      <div className="stack-4">
        <FeedbackBanner tone={feedback.tone} message={feedback.message} />

        <KpiRow>
          <Kpi label="Expected PUs" value={formatCount(status.totals.expectedPollingUnits)} />
          <Kpi
            label="Checked in"
            value={formatCount(status.totals.checkedInPollingUnits)}
            note={`${formatCount(status.totals.expectedPollingUnits - status.totals.checkedInPollingUnits)} outstanding`}
          />
          <Kpi label="Reporting" value={pct(status.totals.reportingPercentage)} />
          <Kpi
            label="Open alerts"
            value={formatCount(activeAlerts.length)}
            note={`${formatCount(criticalAlerts.length)} critical`}
            tone={criticalAlerts.length > 0 ? "warn" : activeAlerts.length > 0 ? "accent" : undefined}
          />
          <Kpi
            label="Critical incidents"
            value={formatCount(status.totals.criticalIncidents)}
            tone={status.totals.criticalIncidents > 0 ? "warn" : undefined}
          />
          <Kpi
            label="Stale tracking"
            value={formatCount(staleUnits.length)}
            note="No recent signal"
            tone={staleUnits.length > 0 ? "warn" : undefined}
          />
        </KpiRow>

        <div className="workbench">
          <Panel
            title="Polling Unit operational status"
            meta={`${formatCount(status.pollingUnits.length)} visible`}
          >
            <div className="stack-3">
              <p className="muted-text">
                Hierarchical status is scoped by backend authorisation. Geofence validation remains gated by
                authoritative Polling Unit geodata.
              </p>
              {/* A status board, not a table: an operator scans this spatially. */}
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
                    <span className="muted">
                      Report: {unit.reportStatus} | Incidents: {unit.openIncidentCount}
                    </span>
                  </button>
                ))}
              </div>
              {status.pollingUnits.length === 0 ? (
                <StateView kind="empty" title="No Polling Units visible in this command scope" />
              ) : null}
            </div>
          </Panel>

          <div className="stack-4">
            <Panel title="Quick controls">
              {selectedPollingUnit ? (
                <div className="stack-3">
                  <DetailList
                    rows={[
                      {
                        label: "Polling Unit",
                        value: <strong>{selectedPollingUnit.pollingUnitName || selectedPollingUnit.pollingUnitId}</strong>,
                      },
                      { label: "Coordinator", value: selectedPollingUnit.coordinatorName || "No assigned coordinator" },
                      {
                        label: "Last seen",
                        value: selectedPollingUnit.lastSeenAt
                          ? new Date(selectedPollingUnit.lastSeenAt).toLocaleString()
                          : "No tracking signal",
                      },
                      { label: "Geofence", value: selectedPollingUnit.geofence.status },
                    ]}
                  />
                  <div className="btn-row">
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={busy || !selectedPollingUnit.coordinatorUserId}
                      onClick={() => void openDirectChat(selectedPollingUnit)}
                    >
                      Message
                    </button>
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={busy || !selectedPollingUnit.coordinatorUserId}
                      onClick={() => void requestCheckIn(selectedPollingUnit)}
                    >
                      Request check-in
                    </button>
                    <Link className="btn btn-sm" href="/admin/election-reports">
                      View reports
                    </Link>
                  </div>
                </div>
              ) : (
                <StateView
                  kind="empty"
                  title="No Polling Unit selected"
                  detail="Select one from the board to message, request a check-in, or inspect its status."
                />
              )}
            </Panel>

            <Panel title="Open a territory chat">
              <form className="stack-3" onSubmit={createTerritoryChat}>
                <Field label="Operations chat title">
                  <input value={territoryChatTitle} onChange={(event) => setTerritoryChatTitle(event.target.value)} />
                </Field>
                <div className="btn-row">
                  <button className="btn btn-primary" type="submit" disabled={busy}>
                    Open territory chat
                  </button>
                </div>
              </form>
            </Panel>

            <Panel title="Voice foundation">
              <DetailList
                rows={[
                  { label: "STUN entries", value: formatCount(webrtc?.iceServers.length || 0) },
                  {
                    label: "TURN",
                    value: webrtc?.turnConfigured ? (
                      <span className="pill pill-executed">configured</span>
                    ) : (
                      <span className="pill pill-refused">not configured</span>
                    ),
                  },
                  { label: "Recording", value: "disabled" },
                  { label: "Call history", value: "Durable — every call and lifecycle event is recorded." },
                ]}
              />
            </Panel>
          </div>
        </div>

        <Panel
          title="Operational alerts"
          meta={`${formatCount(criticalAlerts.length)} critical`}
          flush
        >
          <div className="panel-body">
            <p className="muted-text">Lifecycle actions are audited and broadcast through the durable outbox.</p>
          </div>
          <DataTable
            head={
              <tr>
                <th>Alert</th>
                <th>Where</th>
                <th>Status</th>
                <th>Detected</th>
                <th className="actions">Action</th>
              </tr>
            }
          >
            {alerts.length === 0 ? (
              <EmptyRow colSpan={5}>
                No durable alerts for this date. Use “Reconcile alerts” to create missing check-in, overdue report and
                stale tracking alerts.
              </EmptyRow>
            ) : (
              alerts.slice(0, 20).map((alert) => (
                <tr key={alert.id}>
                  <td>
                    <strong>{alert.type.replaceAll("_", " ").toLowerCase()}</strong>
                    <div className="muted-text">{alert.message}</div>
                  </td>
                  <td className="muted-text">{alert.territory.pollingUnitId || "territory"}</td>
                  <td>
                    <span className={`status-pill ${statusTone(alert.status)}`}>{alert.status}</span>
                  </td>
                  <td className="muted-text">{new Date(alert.detectedAt).toLocaleString()}</td>
                  <td className="actions">
                    <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy || alert.status === "ACKNOWLEDGED"}
                        onClick={() => void handleAlertStatus(alert.id, "ACKNOWLEDGED")}
                      >
                        Acknowledge
                      </button>
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy || alert.status === "ESCALATED"}
                        onClick={() => void handleAlertStatus(alert.id, "ESCALATED")}
                      >
                        Escalate
                      </button>
                      <button
                        className="btn btn-sm btn-primary"
                        type="button"
                        disabled={busy || alert.status === "RESOLVED"}
                        onClick={() => void handleAlertStatus(alert.id, "RESOLVED")}
                      >
                        Resolve
                      </button>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </DataTable>
        </Panel>

        <Panel title="Election operations chat" meta={`${formatCount(conversations.length)} chats`}>
          <div className="stack-3">
            <p className="muted-text">Direct, group and territory conversations are permission-scoped and durable.</p>
            {/* Chat stays chat: a conversation is not a queue. */}
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
                    <span>
                      {conversation.type} | {conversation.members.length} members
                    </span>
                    <span>{conversation.unreadCount} unread</span>
                  </button>
                ))}
                {conversations.length === 0 ? (
                  <p className="muted-text">No conversations yet. Open a territory chat or select a PU to message.</p>
                ) : null}
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
                  {selectedConversation && messages.length === 0 ? (
                    <p className="muted-text">No messages in this conversation yet.</p>
                  ) : null}
                </div>
                <form className="message-form" onSubmit={sendMessage}>
                  <label className="sr-only" htmlFor="situation-message">
                    Message
                  </label>
                  <input
                    id="situation-message"
                    value={messageDraft}
                    onChange={(event) => setMessageDraft(event.target.value)}
                    placeholder="Send an operational update…"
                    disabled={!selectedConversationId}
                  />
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={busy || !selectedConversationId || !messageDraft.trim()}
                  >
                    Send
                  </button>
                </form>
              </div>
            </div>
          </div>
        </Panel>

        {callToken ? (
          <Panel title="Voice">
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
          </Panel>
        ) : null}

        <Panel title="Operational timeline" meta={`${formatCount(timeline.length)} events`}>
          <div className="stack-3">
            <p className="muted-text">
              Reports, alerts, incidents, messages, field activity and durable realtime outbox events.
            </p>
            {/* A timeline is ordered by time and read downwards; columns would
                add nothing a table row does better. */}
            <div className="timeline-list">
              {timeline.map((item) => (
                <article key={`${item.type}-${item.id}`} className="timeline-item">
                  <span className={`timeline-dot ${item.severity === "CRITICAL" ? "critical" : ""}`} />
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                    <p className="muted-text">
                      {item.type} | {new Date(item.occurredAt).toLocaleString()} | {item.pollingUnitId || "territory"}
                    </p>
                  </div>
                </article>
              ))}
            </div>
            {timeline.length === 0 ? <StateView kind="empty" title="No timeline events for this date" /> : null}
          </div>
        </Panel>
      </div>
    </main>
  );
}
