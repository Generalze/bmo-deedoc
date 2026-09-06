"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ElectionDayCallItem, ElectionDayWebrtcConfig } from "@pics-nigeria/shared";
import {
  API_BASE_URL,
  ApiError,
  acceptElectionDayCall,
  endElectionDayCall,
  fetchCurrentUser,
  fetchElectionDayCall,
  fetchElectionDayCalls,
  fetchElectionDayWebrtcConfig,
  initiateElectionDayCall,
  rejectElectionDayCall,
} from "../lib/api";
import {
  acquireRealtimeSocket,
  releaseRealtimeSocket,
  type CallLifecycleEvent,
  type CallSignalEvent,
} from "../lib/realtime";
import { readSession } from "../lib/session";

/**
 * The call centre.
 *
 * Voice previously lived entirely inside a panel on the Situation Room, so a
 * call could only ring if the person being called happened to have that one
 * page open. That is why an incoming call surfaced as a notification rather
 * than as a call: nothing was listening anywhere else.
 *
 * This sits above the page tree. It owns the realtime connection, the WebRTC
 * negotiation and the single active call, so any signed-in operator rings
 * wherever they are, and the Situation Room panel becomes one view onto state
 * that no longer belongs to it.
 *
 * The durable lifecycle still belongs to the REST API. Nothing here invents a
 * status: it drives media, and mirrors what PostgreSQL recorded.
 *
 * Calls are never recorded. No media is captured, stored or uploaded.
 */

type CallPhase = "idle" | "dialling" | "ringing" | "connecting" | "connected" | "ending";

export type CallContact = { userId: string; name: string; role?: string };

type CallCenterValue = {
  ready: boolean;
  config: ElectionDayWebrtcConfig | null;
  connected: boolean;
  phase: CallPhase;
  call: ElectionDayCallItem | null;
  /** True when this user is the one being called and has not answered yet. */
  incoming: boolean;
  history: ElectionDayCallItem[];
  error: string | null;
  /** Set when the browser refused to auto-play the remote audio. */
  audioBlocked: boolean;
  micMuted: boolean;
  /** Seconds since the call connected, ticking. */
  elapsedSeconds: number;
  selfUserId: string | null;
  start: (targetUserId: string, conversationId?: string) => Promise<void>;
  answer: () => Promise<void>;
  decline: () => Promise<void>;
  hangUp: () => Promise<void>;
  toggleMute: () => void;
  resumeAudio: () => void;
  dismissError: () => void;
  refreshHistory: () => Promise<void>;
};

const CallCenterContext = createContext<CallCenterValue | null>(null);

export function useCallCenter() {
  return useContext(CallCenterContext);
}

function otherParticipant(call: ElectionDayCallItem | null, selfUserId: string | null) {
  if (!call) return null;
  return call.participants.find((participant) => participant.userId !== selfUserId) || null;
}

export function CallCenterProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [selfUserId, setSelfUserId] = useState<string | null>(null);
  const [config, setConfig] = useState<ElectionDayWebrtcConfig | null>(null);
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [call, setCall] = useState<ElectionDayCallItem | null>(null);
  const [history, setHistory] = useState<ElectionDayCallItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const socketRef = useRef<ReturnType<typeof acquireRealtimeSocket> | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callRef = useRef<ElectionDayCallItem | null>(null);
  const selfRef = useRef<string | null>(null);

  /**
   * A caller sends its offer the moment the call record exists, which is while
   * the callee is still deciding. Candidates likewise arrive before either side
   * has a remote description. Both are held until there is somewhere to put
   * them, rather than being dropped — dropping them is what leaves a call
   * ringing forever and then timing out.
   */
  const pendingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  callRef.current = call;
  selfRef.current = selfUserId;

  /* ---- session ---------------------------------------------------------- */

  useEffect(() => {
    const active = readSession();
    setToken(active);
    if (!active) return;
    void (async () => {
      try {
        const profile = await fetchCurrentUser(active);
        setSelfUserId(profile.id);
      } catch {
        // Not signed in, or the token expired. Voice simply stays unavailable;
        // it must never block the page it is mounted above.
        setToken(null);
      }
    })();
  }, []);

  /* ---- media ------------------------------------------------------------ */

  const teardownMedia = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    pendingOfferRef.current = null;
    pendingCandidatesRef.current = [];
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    setMicMuted(false);
    setAudioBlocked(false);
    setElapsedSeconds(0);
  }, []);

  const emitSignal = useCallback(
    (callId: string, targetUserId: string, signalType: "offer" | "answer" | "candidate", signal: unknown) => {
      socketRef.current?.emit(
        "call.signal",
        { callId, targetUserId, signalType, signal },
        (response?: { ok?: boolean; message?: string }) => {
          if (response && response.ok === false) {
            setError(response.message || "The call signal was refused.");
          }
        },
      );
    },
    [],
  );

  /**
   * Builds the peer connection for a call. Trickle ICE is sent as it is
   * gathered rather than waiting for gathering to complete, which is what makes
   * a call connect in a second or two instead of stalling.
   */
  const createPeer = useCallback(
    async (callId: string, targetUserId: string) => {
      if (!config) {
        throw new Error("Call configuration is unavailable.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      localStreamRef.current = stream;

      const peer = new RTCPeerConnection({ iceServers: config.iceServers });
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          emitSignal(callId, targetUserId, "candidate", event.candidate.toJSON());
        }
      };

      peer.ontrack = (event) => {
        const [remote] = event.streams;
        if (!audioRef.current || !remote) return;
        audioRef.current.srcObject = remote;
        // Autoplay policy blocks this on a page the user has not interacted
        // with. Surfacing it is the difference between "no audio" and "tap to
        // hear", which previously read as a broken call.
        void audioRef.current.play().then(
          () => setAudioBlocked(false),
          () => setAudioBlocked(true),
        );
      };

      peer.onconnectionstatechange = () => {
        const state = peer.connectionState;
        if (state === "connected") {
          setPhase((previous) => (previous === "connected" ? previous : "connected"));
        }
        if (state === "failed") {
          setError(
            config.turnConfigured
              ? "The media connection failed. Both devices may be on networks the relay cannot cross."
              : "The media connection failed and no TURN relay is configured, so calls cannot cross restrictive mobile networks.",
          );
        }
      };

      peerRef.current = peer;
      return peer;
    },
    [config, emitSignal],
  );

  /** Applies candidates that arrived before the remote description existed. */
  const flushPendingCandidates = useCallback(async () => {
    const peer = peerRef.current;
    if (!peer || !peer.remoteDescription) return;
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      await peer.addIceCandidate(candidate).catch(() => undefined);
    }
  }, []);

  /* ---- history ---------------------------------------------------------- */

  const refreshHistory = useCallback(async () => {
    if (!token) return;
    try {
      const items = await fetchElectionDayCalls(token, { limit: 20 });
      setHistory(items);
    } catch {
      // History is informational; a failure here must not disturb a live call.
    }
  }, [token]);

  /* ---- lifecycle -------------------------------------------------------- */

  const finishCall = useCallback(() => {
    teardownMedia();
    setCall(null);
    setPhase("idle");
    void refreshHistory();
  }, [teardownMedia, refreshHistory]);

  const start = useCallback(
    async (targetUserId: string, conversationId?: string) => {
      if (!token) return;
      setError(null);
      setPhase("dialling");
      let created: ElectionDayCallItem | null = null;
      try {
        // The record exists first: the relay authorises a signal against a live
        // call, so there is nothing to sign about until the call is real.
        created = await initiateElectionDayCall(token, { targetUserId, conversationId });
        setCall(created);

        const peer = await createPeer(created.id, targetUserId);
        const offer = await peer.createOffer({ offerToReceiveAudio: true });
        await peer.setLocalDescription(offer);
        emitSignal(created.id, targetUserId, "offer", peer.localDescription?.toJSON() ?? offer);
        setPhase("ringing");
        await refreshHistory();
      } catch (caught) {
        teardownMedia();
        if (created) {
          await endElectionDayCall(token, created.id, "CANCELLED").catch(() => undefined);
        }
        setCall(null);
        setPhase("idle");
        setError(
          caught instanceof ApiError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : "The call could not be started.",
        );
      }
    },
    [token, createPeer, emitSignal, refreshHistory, teardownMedia],
  );

  const answer = useCallback(async () => {
    const active = callRef.current;
    if (!token || !active) return;
    const other = otherParticipant(active, selfRef.current);
    if (!other) return;

    setError(null);
    setPhase("connecting");
    try {
      const accepted = await acceptElectionDayCall(token, active.id);
      setCall(accepted);

      const peer = await createPeer(active.id, other.userId);
      const offer = pendingOfferRef.current;
      if (!offer) {
        // The caller's offer has not arrived. Rather than sit silently, say so:
        // the call stays open and the offer is applied the moment it lands.
        setError("Waiting for the caller's connection details…");
      } else {
        await peer.setRemoteDescription(offer);
        pendingOfferRef.current = null;
        await flushPendingCandidates();
        const localAnswer = await peer.createAnswer();
        await peer.setLocalDescription(localAnswer);
        emitSignal(active.id, other.userId, "answer", peer.localDescription?.toJSON() ?? localAnswer);
      }
      await refreshHistory();
    } catch (caught) {
      teardownMedia();
      setPhase("idle");
      setCall(null);
      setError(caught instanceof ApiError ? caught.message : "The call could not be answered.");
    }
  }, [token, createPeer, emitSignal, flushPendingCandidates, refreshHistory, teardownMedia]);

  const decline = useCallback(async () => {
    const active = callRef.current;
    if (!token || !active) return;
    setPhase("ending");
    try {
      await rejectElectionDayCall(token, active.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The call could not be declined.");
    } finally {
      finishCall();
    }
  }, [token, finishCall]);

  const hangUp = useCallback(async () => {
    const active = callRef.current;
    if (!token || !active) return;
    setPhase("ending");
    try {
      // A call that never connected was cancelled, not completed. Recording it
      // as completed would put a zero-length "call" in the history.
      await endElectionDayCall(token, active.id, active.status === "CONNECTED" ? "COMPLETED" : "CANCELLED");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The call could not be ended.");
    } finally {
      finishCall();
    }
  }, [token, finishCall]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !micMuted;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMicMuted(next);
  }, [micMuted]);

  const resumeAudio = useCallback(() => {
    void audioRef.current?.play().then(
      () => setAudioBlocked(false),
      () => setAudioBlocked(true),
    );
  }, []);

  /* ---- realtime --------------------------------------------------------- */

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    void (async () => {
      try {
        const loaded = await fetchElectionDayWebrtcConfig(token);
        if (!cancelled) setConfig(loaded);
      } catch {
        // Voice is unavailable without ICE configuration, but the rest of the
        // application must keep working.
      }
      if (!cancelled) await refreshHistory();
    })();

    return () => {
      cancelled = true;
    };
  }, [token, refreshHistory]);

  useEffect(() => {
    if (!token) return;

    const socket = acquireRealtimeSocket(token, config?.signalling.path);
    socketRef.current = socket;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    const onRinging = async (event: CallLifecycleEvent) => {
      const callId = event.payload?.callId;
      if (!callId || callRef.current) return;
      // The initiator already has the record from its own POST.
      if (event.payload?.initiatorUserId === selfRef.current) return;
      try {
        const incoming = await fetchElectionDayCall(token, callId);
        setCall(incoming);
        setPhase("ringing");
      } catch {
        // A call we cannot read is a call we are not party to.
      }
    };

    const onAccepted = async (event: CallLifecycleEvent) => {
      const callId = event.payload?.callId;
      if (!callId || callRef.current?.id !== callId) return;
      setPhase((previous) => (previous === "connected" ? previous : "connecting"));
      try {
        setCall(await fetchElectionDayCall(token, callId));
      } catch {
        // Keep the local record; the lifecycle event already told us enough.
      }
    };

    const onEnded = (event: CallLifecycleEvent) => {
      const callId = event.payload?.callId;
      if (!callId || callRef.current?.id !== callId) return;
      finishCall();
    };

    const onSignal = async (event: CallSignalEvent) => {
      const active = callRef.current;
      if (!active || event.callId !== active.id) return;
      if (event.targetUserId !== selfRef.current) return;

      const peer = peerRef.current;

      if (event.signalType === "offer") {
        const offer = event.signal as RTCSessionDescriptionInit;
        if (!peer) {
          // Still ringing: hold it until this user answers.
          pendingOfferRef.current = offer;
          return;
        }
        await peer.setRemoteDescription(offer).catch(() => undefined);
        await flushPendingCandidates();
        const localAnswer = await peer.createAnswer();
        await peer.setLocalDescription(localAnswer);
        emitSignal(active.id, event.fromUserId, "answer", peer.localDescription?.toJSON() ?? localAnswer);
        setError(null);
        return;
      }

      if (event.signalType === "answer") {
        if (!peer || peer.signalingState === "stable") return;
        await peer.setRemoteDescription(event.signal as RTCSessionDescriptionInit).catch(() => undefined);
        await flushPendingCandidates();
        return;
      }

      if (event.signalType === "candidate") {
        const candidate = event.signal as RTCIceCandidateInit | null;
        if (!candidate) return;
        if (!peer || !peer.remoteDescription) {
          pendingCandidatesRef.current.push(candidate);
          return;
        }
        await peer.addIceCandidate(candidate).catch(() => undefined);
      }
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("call.ringing", onRinging);
    socket.on("call.accepted", onAccepted);
    socket.on("call.connected", onAccepted);
    socket.on("call.rejected", onEnded);
    socket.on("call.ended", onEnded);
    socket.on("call.missed", onEnded);
    socket.on("call.signal", onSignal);
    if (socket.connected) setConnected(true);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("call.ringing", onRinging);
      socket.off("call.accepted", onAccepted);
      socket.off("call.connected", onAccepted);
      socket.off("call.rejected", onEnded);
      socket.off("call.ended", onEnded);
      socket.off("call.missed", onEnded);
      socket.off("call.signal", onSignal);
      socketRef.current = null;
      releaseRealtimeSocket(token);
    };
  }, [token, config?.signalling.path, emitSignal, flushPendingCandidates, finishCall]);

  /* ---- duration --------------------------------------------------------- */

  useEffect(() => {
    if (phase !== "connected" || !call?.connectedAt) {
      return;
    }
    const startedAt = new Date(call.connectedAt).getTime();
    const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [phase, call?.connectedAt]);

  /* ---- teardown --------------------------------------------------------- */

  useEffect(() => teardownMedia, [teardownMedia]);

  /**
   * A tab closed mid-call leaves the other side ringing into nothing. The
   * lifecycle is durable, so it is ended deliberately rather than left for a
   * timeout to notice.
   */
  useEffect(() => {
    if (!token) return;
    const onUnload = () => {
      const active = callRef.current;
      if (!active) return;
      // keepalive lets the request outlive the page. sendBeacon cannot carry an
      // Authorization header, and this endpoint requires one.
      void fetch(`${API_BASE_URL}/election-day/calls/${active.id}/end`, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endReason: active.status === "CONNECTED" ? "COMPLETED" : "CANCELLED" }),
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [token]);

  const incoming = Boolean(call && selfUserId && call.initiatorUserId !== selfUserId && call.status === "RINGING");

  const value = useMemo<CallCenterValue>(
    () => ({
      ready: Boolean(token && config),
      config,
      connected,
      phase,
      call,
      incoming,
      history,
      error,
      audioBlocked,
      micMuted,
      elapsedSeconds,
      selfUserId,
      start,
      answer,
      decline,
      hangUp,
      toggleMute,
      resumeAudio,
      dismissError: () => setError(null),
      refreshHistory,
    }),
    [
      token,
      config,
      connected,
      phase,
      call,
      incoming,
      history,
      error,
      audioBlocked,
      micMuted,
      elapsedSeconds,
      selfUserId,
      start,
      answer,
      decline,
      hangUp,
      toggleMute,
      resumeAudio,
      refreshHistory,
    ],
  );

  return (
    <CallCenterContext.Provider value={value}>
      {children}
      {/* The single remote audio sink for the whole application. */}
      <audio ref={audioRef} autoPlay playsInline />
      <IncomingCallDialog />
    </CallCenterContext.Provider>
  );
}

/**
 * The call itself, wherever the operator happens to be.
 *
 * Ringing used to require the Situation Room to be open, so a call arrived as a
 * notification about a call rather than as a call.
 */
function IncomingCallDialog() {
  const center = useContext(CallCenterContext);
  if (!center || !center.call) return null;
  if (center.phase === "idle") return null;

  const other = otherParticipant(center.call, center.selfUserId);
  const ringing = center.incoming;

  return (
    <div className="call-overlay" role="dialog" aria-modal="true" aria-label={ringing ? "Incoming call" : "Call"}>
      <div className="call-card">
        <span className="call-card-state">
          {ringing
            ? "Incoming call"
            : center.phase === "connected"
              ? "Connected"
              : center.phase === "connecting"
                ? "Connecting…"
                : center.phase === "ending"
                  ? "Ending…"
                  : "Calling…"}
        </span>
        <strong className="call-card-name">{other?.name || "Unknown contact"}</strong>
        {other?.role ? <span className="call-card-role">{other.role.replace(/_/g, " ").toLowerCase()}</span> : null}

        {center.phase === "connected" ? (
          <span className="call-card-timer" aria-live="off">
            {formatElapsed(center.elapsedSeconds)}
          </span>
        ) : (
          <span className="call-card-pulse" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}

        {center.audioBlocked ? (
          <button className="btn btn-primary" type="button" onClick={center.resumeAudio}>
            Tap to hear the call
          </button>
        ) : null}

        {center.error ? <p className="call-card-error">{center.error}</p> : null}

        <div className="call-card-actions">
          {ringing ? (
            <>
              <button className="call-btn call-btn-accept" type="button" onClick={() => void center.answer()}>
                Answer
              </button>
              <button className="call-btn call-btn-end" type="button" onClick={() => void center.decline()}>
                Decline
              </button>
            </>
          ) : (
            <>
              {center.phase === "connected" ? (
                <button
                  className={center.micMuted ? "call-btn call-btn-muted" : "call-btn"}
                  type="button"
                  aria-pressed={center.micMuted}
                  onClick={center.toggleMute}
                >
                  {center.micMuted ? "Unmute" : "Mute"}
                </button>
              ) : null}
              <button className="call-btn call-btn-end" type="button" onClick={() => void center.hangUp()}>
                {center.phase === "connected" ? "Hang up" : "Cancel"}
              </button>
            </>
          )}
        </div>

        <span className="call-card-note">Calls are never recorded.</span>
      </div>
    </div>
  );
}

export function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
