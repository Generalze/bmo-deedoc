"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createAgentActivity, fetchCurrentUser, logoutCurrentUser } from "../lib/api";
import { clearSession, readSession } from "../lib/session";

const TRACKING_EVENT_NAME = "pics-agent-tracking";

function dispatchTrackingEvent(detail: { active: boolean; status: string; lastPingAt?: string | null }) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(TRACKING_EVENT_NAME, { detail }));
}

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

export function AgentSessionTracker() {
  const pathname = usePathname();
  const router = useRouter();
  const watchIdRef = useRef<number | null>(null);
  const lastSentAtRef = useRef(0);
  const logoutInProgressRef = useRef(false);

  useEffect(() => {
    if (!pathname.startsWith("/agent")) {
      return;
    }

    const initialToken = readSession();
    if (!initialToken) {
      return;
    }
    const trackerToken = initialToken;

    function clearTracker() {
      if (watchIdRef.current !== null && typeof navigator !== "undefined" && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    }

    async function forceLogout(reason: "gps-required" | "session-ended") {
      if (logoutInProgressRef.current) {
        return;
      }

      logoutInProgressRef.current = true;
      clearTracker();
      dispatchTrackingEvent({
        active: false,
        status:
          reason === "gps-required"
            ? "Device GPS is required for agent tracking."
            : "This agent session is no longer active.",
      });

      try {
        const logoutToken = readSession();
        if (logoutToken) {
          await logoutCurrentUser(logoutToken);
        }
      } catch {
        // Best effort.
      }

      clearSession();
      router.replace(`/login?field=1&reason=${encodeURIComponent(reason)}`);
    }

    async function sendLocation(position: GeolocationPosition) {
      const now = Date.now();
      if (now - lastSentAtRef.current < 30_000) {
        return;
      }

      lastSentAtRef.current = now;
      await createAgentActivity(trackerToken, "location", {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : undefined,
      });

      dispatchTrackingEvent({
        active: true,
        status: "Live tracking is active.",
        lastPingAt: new Date().toISOString(),
      });
    }

    function beginTracking() {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        void forceLogout("gps-required");
        return;
      }

      dispatchTrackingEvent({
        active: true,
        status: "Starting device GPS tracking...",
        lastPingAt: null,
      });

      watchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          void sendLocation(position).catch((caughtError) => {
            const message = caughtError instanceof Error ? caughtError.message : "Location sync failed.";
            dispatchTrackingEvent({ active: true, status: message, lastPingAt: null });
          });
        },
        () => {
          void forceLogout("gps-required");
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 20_000,
        },
      );
    }

    readCurrentPosition()
      .then((position) => sendLocation(position))
      .then(() => {
        beginTracking();
      })
      .catch(() => {
        void forceLogout("gps-required");
      });

    const sessionInterval = window.setInterval(() => {
      const currentToken = readSession();
      if (!currentToken) {
        void forceLogout("session-ended");
        return;
      }

      readCurrentPosition()
        .then(() => fetchCurrentUser(currentToken))
        .catch((caughtError) => {
          const message = caughtError instanceof Error ? caughtError.message : "";
          void forceLogout(message.includes("GPS") || message.includes("location") ? "gps-required" : "session-ended");
        });
    }, 60_000);

    return () => {
      clearTracker();
      window.clearInterval(sessionInterval);
    };
  }, [pathname, router]);

  return null;
}

export const AGENT_TRACKING_EVENT_NAME = TRACKING_EVENT_NAME;
