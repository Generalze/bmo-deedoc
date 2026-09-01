"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AuthUserProfile, OgunOrganizationTree } from "@pics-nigeria/shared";
import { ApiError, fetchCurrentUser, fetchOgunOrganizationTree, logoutCurrentUser } from "../../lib/api";
import { clearSession, readSession } from "../../lib/session";

export default function PlatformOrganizationPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [tree, setTree] = useState<OgunOrganizationTree | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = readSession();
    if (!token) {
      router.push("/login");
      return;
    }

    Promise.all([fetchCurrentUser(token), fetchOgunOrganizationTree(token)])
      .then(([currentUser, organizationTree]) => {
        if (!["SUPER_ADMIN", "STATE_OFFICER", "COORDINATOR"].includes(currentUser.role)) {
          throw new ApiError("This page requires Ogun command access.", 403);
        }
        setUser(currentUser);
        setTree(organizationTree);
      })
      .catch((caughtError) => {
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load the organization tree.");
      });
  }, [router]);

  async function signOut() {
    const token = readSession();
    if (token) {
      await logoutCurrentUser(token).catch(() => undefined);
    }
    clearSession();
    router.push("/login");
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Ogun command architecture</p>
        <h1>Organization tree</h1>
        <p>
          {user
            ? `${user.name} | ${user.role}${user.coordinatorProfile ? ` | ${user.coordinatorProfile.level}` : ""}`
            : "Loading authorized territory..."}
        </p>
        <button className="button secondary" type="button" onClick={() => void signOut()}>Sign out</button>
      </section>

      {error ? (
        <section className="panel" style={{ marginTop: 24 }}>
          <h2>Organization data unavailable</h2>
          <p className="error">{error}</p>
          <p className="muted">Assignments remain blocked until authoritative Ogun command relationships are complete.</p>
        </section>
      ) : null}

      {tree ? (
        <section className="panel" style={{ marginTop: 24 }}>
          <h2>{tree.name}</h2>
          <p className="muted">State Officers: {tree.stateOfficers.map((officer) => officer.name).join(", ") || "Hidden for scoped view"}</p>
          <div className="card-grid">
            {tree.senatorialDistricts.map((senatorial) => (
              <article className="card" key={senatorial.id}>
                <p className="eyebrow">Senatorial District</p>
                <h3>{senatorial.name}</h3>
                <p className="muted">{senatorial.coordinators.length} assigned coordinator(s)</p>
                {senatorial.federalConstituencies.map((federal) => (
                  <div key={federal.id} style={{ marginTop: 18 }}>
                    <strong>{federal.name}</strong>
                    <p className="muted">
                      {federal.stateConstituencies.length} State Constituency branch(es) | {federal.coordinators.length} coordinator(s)
                    </p>
                    {federal.stateConstituencies.map((stateConstituency) => (
                      <p key={stateConstituency.id}>
                        {stateConstituency.name}: {stateConstituency.wards.length} Ward(s)
                      </p>
                    ))}
                  </div>
                ))}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
