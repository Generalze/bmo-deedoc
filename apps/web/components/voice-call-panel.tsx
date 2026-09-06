"use client";

import { useState } from "react";
import type { ElectionDayCallItem } from "@pics-nigeria/shared";
import { DataTable, EmptyRow, Notice, Panel, StateView, Toolbar, ToolbarEnd, ToolbarField, formatCount } from "./ui";
import { formatElapsed, useCallCenter, type CallContact } from "./call-center";

type Props = {
  token: string;
  /** Contacts the signed-in user is permitted to call. */
  contacts: CallContact[];
};

function statusLabel(call: ElectionDayCallItem) {
  if (call.status === "ENDED") {
    return call.endReason === "MISSED"
      ? "Missed"
      : call.endReason === "REJECTED"
        ? "Declined"
        : call.endReason === "CANCELLED"
          ? "Cancelled"
          : "Completed";
  }
  return call.status === "CONNECTED" ? "Connected" : "Ringing";
}

function statusTone(call: ElectionDayCallItem) {
  if (call.status !== "ENDED") return "pill pill-pending";
  switch (call.endReason) {
    case "MISSED":
      return "pill pill-error";
    case "REJECTED":
      return "pill pill-refused";
    case "CANCELLED":
      return "pill pill-stale";
    default:
      return "pill pill-executed";
  }
}

/**
 * The Situation Room's view of voice.
 *
 * The call itself is owned by the call centre above the page tree, so this
 * panel starts calls and reads history — it no longer holds the peer
 * connection, and a call it started survives navigating away from this page.
 *
 * Calls are never recorded. No media is captured or uploaded anywhere.
 */
export function VoiceCallPanel({ contacts }: Props) {
  const center = useCallCenter();
  const [targetUserId, setTargetUserId] = useState("");

  if (!center) {
    return (
      <Panel title="Voice">
        <StateView kind="error" title="Voice is unavailable" detail="The call centre is not mounted." />
      </Panel>
    );
  }

  const callable = contacts.filter((contact) => contact.userId);
  const busy = center.phase !== "idle";

  return (
    <Panel
      title="Voice"
      meta={
        center.connected ? (
          <span className="pill pill-executed">realtime connected</span>
        ) : (
          <span className="pill pill-refused">realtime offline</span>
        )
      }
      flush
    >
      <Toolbar>
        <ToolbarField label="Call">
          <select
            value={targetUserId}
            onChange={(event) => setTargetUserId(event.target.value)}
            disabled={busy || !center.ready}
          >
            <option value="">Select a contact…</option>
            {callable.map((contact) => (
              <option key={contact.userId} value={contact.userId}>
                {contact.name}
                {contact.role ? ` · ${contact.role.replace(/_/g, " ").toLowerCase()}` : ""}
              </option>
            ))}
          </select>
        </ToolbarField>
        <ToolbarEnd>
          <button
            className="btn btn-sm btn-primary"
            type="button"
            onClick={() => void center.start(targetUserId)}
            disabled={busy || !targetUserId || !center.ready || !center.connected}
          >
            {busy ? "In a call" : "Start call"}
          </button>
        </ToolbarEnd>
      </Toolbar>

      <div className="panel-body stack-2">
        {!center.connected ? (
          <Notice tone="refused" title="Not connected to the realtime gateway">
            <span>
              Calls need the signalling connection. Without it a call can be recorded but no audio can be exchanged.
            </span>
          </Notice>
        ) : null}

        {center.config && !center.config.turnConfigured ? (
          <Notice tone="legacy" title="No TURN relay configured">
            <span>
              Calls will connect between devices that can reach each other directly, and will fail on restrictive
              mobile networks until a TURN relay is configured.
            </span>
          </Notice>
        ) : null}

        {center.error ? (
          <Notice tone="error" title="Call problem">
            <span>{center.error}</span>
          </Notice>
        ) : null}

        <p className="muted-text">Calls are never recorded. No media is captured, stored or uploaded.</p>
      </div>

      <DataTable
        caption="Recent calls"
        head={
          <tr>
            <th>Outcome</th>
            <th>Participants</th>
            <th>Started</th>
            <th className="numeric">Duration</th>
          </tr>
        }
      >
        {center.history.length === 0 ? (
          <EmptyRow colSpan={4}>No calls yet.</EmptyRow>
        ) : (
          center.history.map((call) => (
            <tr key={call.id}>
              <td>
                <span className={statusTone(call)}>{statusLabel(call).toLowerCase()}</span>
              </td>
              <td>{call.participants.map((participant) => participant.name).join(" ↔ ")}</td>
              <td className="muted-text">{new Date(call.startedAt).toLocaleString()}</td>
              <td className="numeric">
                {call.durationSeconds === null ? "—" : formatElapsed(call.durationSeconds)}
              </td>
            </tr>
          ))
        )}
      </DataTable>

      <div className="panel-body">
        <span className="muted-text">{formatCount(center.history.length)} recorded in the durable call log</span>
      </div>
    </Panel>
  );
}
