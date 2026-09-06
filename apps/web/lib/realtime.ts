"use client";

import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "./api";

/**
 * One realtime connection for the whole tab.
 *
 * The web app had no socket client at all — `socket.io-client` was not even a
 * dependency — while the API had a complete, authorised signalling relay
 * waiting for it. Every voice symptom followed from that single gap: a callee
 * never learned a call was ringing, no SDP was ever exchanged, and no ICE
 * candidate ever crossed, so a "call" was two peers holding microphones that
 * could not reach each other.
 *
 * A socket is shared by every consumer holding the same token and closed once
 * the last one lets go, so opening a second screen does not open a second
 * connection — and does not double-deliver a ringing event.
 */

type Entry = {
  socket: Socket;
  refCount: number;
};

let current: (Entry & { token: string }) | null = null;

/**
 * The API base is an HTTP origin plus an optional path prefix. Socket.IO wants
 * the origin to connect to and the path separately, so they are split here
 * rather than at each call site.
 */
function splitApiBase(): { origin: string; prefix: string } {
  try {
    const url = new URL(API_BASE_URL, typeof window === "undefined" ? "http://localhost" : window.location.href);
    const prefix = url.pathname.replace(/\/$/, "");
    return { origin: url.origin, prefix: prefix === "/" ? "" : prefix };
  } catch {
    return { origin: API_BASE_URL, prefix: "" };
  }
}

export function acquireRealtimeSocket(token: string, socketPath?: string): Socket {
  if (current && current.token === token) {
    current.refCount += 1;
    return current.socket;
  }

  if (current) {
    // A different identity signed in on this tab. The old socket carries the
    // old user's presence room and must not survive the switch.
    current.socket.disconnect();
    current = null;
  }

  const { origin, prefix } = splitApiBase();
  const socket = io(origin, {
    path: `${prefix}${socketPath || "/socket.io"}`,
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    // The handshake carries the token itself, so no cookie is needed.
    withCredentials: false,
  });

  current = { socket, refCount: 1, token };
  return socket;
}

export function releaseRealtimeSocket(token: string) {
  if (!current || current.token !== token) {
    return;
  }
  current.refCount -= 1;
  if (current.refCount <= 0) {
    current.socket.disconnect();
    current = null;
  }
}

/** Payload of a `call.signal` relay, as the gateway emits it. */
export type CallSignalEvent = {
  callId: string;
  conversationId: string | null;
  fromUserId: string;
  targetUserId: string;
  signalType: "offer" | "answer" | "candidate";
  signal: unknown;
  occurredAt: string;
};

/** Envelope shape shared by every `call.*` lifecycle event. */
export type CallLifecycleEvent = {
  eventType: string;
  payload: {
    callId: string;
    conversationId?: string | null;
    initiatorUserId?: string;
    status?: string;
    participantUserIds?: string[];
    targetUserId?: string;
  };
};
