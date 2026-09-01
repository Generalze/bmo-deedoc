"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { PublicAccessShell } from "../components/public-access-shell";
import { loginUser } from "../lib/api";
import { saveSession } from "../lib/session";

export default function HomePage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const data = await loginUser(email, password);

      if (data.user.role !== "VOTER" && data.user.role !== "MEMBER") {
        setError("This login page is for members only.");
        return;
      }

      saveSession(data.token);
      router.push("/dashboard");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Login failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <PublicAccessShell
      currentAccess="VOTER"
      brandSubtitle="Voter Access Portal"
      authTitle="Voter Sign In"
      authDescription="Sign in with your voter account to view your referral code, reward activity, and civic updates."
      footerNote="New voter? Create your account or confirm your polling unit first."
    >
      <form className="starter-form" onSubmit={handleSubmit}>
        <label className="starter-form__field">
          <span>Email address</span>
          <input
            type="email"
            placeholder="ada@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>

        <label className="starter-form__field">
          <span>Password</span>
          <input
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button type="submit" className="starter-form__submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign in to your account"}
        </button>

        <p className="starter-form__meta">
          <Link href="/register">Create voter account</Link> {" | "}
          <Link href="/polling-units">Find polling unit location</Link>
        </p>
      </form>
    </PublicAccessShell>
  );
}
