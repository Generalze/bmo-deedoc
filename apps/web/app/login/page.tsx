"use client";

import Link from "next/link";
import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PublicAccessShell } from "../../components/public-access-shell";
import { loginUser } from "../../lib/api";
import { canSignIn, clearSession, homeForRole, saveSession } from "../../lib/session";

/**
 * The single sign-in door.
 *
 * There were four — member, admin, agent, candidate — differing only in a role
 * predicate, a storage key and a destination. Each wrote its own token, and each
 * sign-out cleared only its own, so a stale token from another role survived and
 * the next page drove with the wrong session. Splitting the door by role also
 * meant an operator had to know which URL their role belonged to before they
 * could get in, and a coordinator who guessed wrong was told they were not
 * authorised rather than sent to the right place.
 *
 * The one genuinely distinct behaviour was the agent's GPS gate, and it survives
 * as a step rather than a separate page: field duty requires consent and a live
 * position before the session is granted, because the platform tracks attendance
 * from it.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Pre-selected when arriving from the old agent door, so the field flow is
  // unchanged for someone following a bookmark.
  const [fieldDuty, setFieldDuty] = useState(params.get("field") === "1");
  const [gpsConsent, setGpsConsent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  /** Field duty needs a real fix, not just a ticked box. */
  function verifyGpsAccess() {
    return new Promise<void>((resolve, reject) => {
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        reject(new Error("Device GPS is required for polling-unit field access."));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        () => resolve(),
        () => reject(new Error("Turn on device GPS and allow location access to continue.")),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      );
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (fieldDuty) {
        if (!gpsConsent) {
          throw new Error("You must agree to the field GPS terms before signing in for polling-unit duty.");
        }
        await verifyGpsAccess();
      }

      const data = await loginUser(email, password, fieldDuty ? { agentGpsConsent: true } : undefined);

      if (!canSignIn(data.user.role)) {
        // Candidates are records the organisation maintains, not operators:
        // the Ogun candidate has a name but no account to sign in with.
        setError(
          "Candidate profiles are managed by the organisation and do not sign in. Contact your state office for access.",
        );
        clearSession();
        return;
      }

      const needsFieldSession =
        data.user.role === "AGENT" ||
        (data.user.role === "COORDINATOR" && data.user.coordinatorProfile?.level === "POLLING_UNIT");
      if (needsFieldSession && !fieldDuty) {
        setError("Polling-unit field access requires GPS. Tick the field duty option and sign in again.");
        setFieldDuty(true);
        return;
      }

      saveSession(data.token);
      router.push(homeForRole(data.user.role));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="starter-form" onSubmit={handleSubmit}>
      <label className="starter-form__field">
        <span>Email address</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          required
        />
      </label>

      <label className="starter-form__field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Enter your password"
          required
        />
      </label>

      <div className="starter-form__field">
        <label className="starter-checkbox-row">
          <input type="checkbox" checked={fieldDuty} onChange={(event) => setFieldDuty(event.target.checked)} />
          <span>I am signing in for polling-unit field duty (requires device GPS).</span>
        </label>
      </div>

      {fieldDuty ? (
        <div className="starter-form__field">
          <span>GPS access agreement</span>
          <label className="starter-checkbox-row">
            <input
              type="checkbox"
              checked={gpsConsent}
              onChange={(event) => setGpsConsent(event.target.checked)}
              required
            />
            <span>
              I agree that this device GPS may be used for attendance, live field tracking, and operational
              transparency while I am signed in.
            </span>
          </label>
          <p className="starter-form__note">
            GPS must be on before field access is granted and remain available during the session.
          </p>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <button className="starter-form__submit" type="submit" disabled={loading}>
        {loading ? "Signing in..." : "Sign in"}
      </button>

      <p className="starter-form__meta">
        <Link href="/register">Create member account</Link> {" | "}
        <Link href="/polling-units">Find polling unit location</Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <PublicAccessShell
      currentAccess="VOTER"
      brandSubtitle="Ogun Election Operations"
      authTitle="Sign In"
      authDescription="One sign-in for members, coordinators, field agents and command staff. You are taken to your own workspace."
      footerNote="Use the same public access hub to register, sign in, or confirm your polling unit."
    >
      <Suspense fallback={<p className="muted">Loading sign in…</p>}>
        <LoginForm />
      </Suspense>
    </PublicAccessShell>
  );
}
