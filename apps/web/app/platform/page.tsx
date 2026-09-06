"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AuthUserProfile, OgunOrganizationTree } from "@pics-nigeria/shared";
import { ApiError, fetchCurrentUser, fetchOgunOrganizationTree, logoutCurrentUser } from "../../lib/api";
import { DataTable, DetailList, EmptyRow, Notice, PageHead, Panel, formatCount } from "../../components/ui";
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
    <main className="console-shell">
      <PageHead
        title="Organisation tree"
        lead={
          user
            ? `${user.name} · ${user.role.replace(/_/g, " ").toLowerCase()}${
                user.coordinatorProfile ? ` · ${user.coordinatorProfile.level.replace(/_/g, " ").toLowerCase()}` : ""
              }`
            : "Loading authorised territory…"
        }
        actions={
          <button className="btn" type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        }
      />

      <div className="stack-4">
        {error ? (
          <Notice tone="error" title="Organisation data unavailable">
            <span>{error}</span>
            <span className="muted-text">
              Assignments remain blocked until authoritative Ogun command relationships are complete.
            </span>
          </Notice>
        ) : null}

        {tree ? (
          <>
            <Panel title={tree.name} meta={`${formatCount(tree.senatorialDistricts.length)} senatorial districts`}>
              <DetailList
                rows={[
                  {
                    label: "State officers",
                    value: tree.stateOfficers.map((officer) => officer.name).join(", ") || "Hidden for scoped view",
                  },
                ]}
              />
            </Panel>

            {tree.senatorialDistricts.map((senatorial) => (
              <Panel
                key={senatorial.id}
                title={senatorial.name}
                meta={`${formatCount(senatorial.coordinators.length)} coordinators`}
                flush
              >
                <DataTable
                  head={
                    <tr>
                      <th>Federal constituency</th>
                      <th>State constituency</th>
                      <th className="numeric">Wards</th>
                      <th className="numeric">Coordinators</th>
                    </tr>
                  }
                >
                  {senatorial.federalConstituencies.length === 0 ? (
                    <EmptyRow colSpan={4}>No federal constituencies loaded for this district.</EmptyRow>
                  ) : (
                    senatorial.federalConstituencies.flatMap((federal) =>
                      federal.stateConstituencies.length === 0
                        ? [
                            <tr key={federal.id}>
                              <td>{federal.name}</td>
                              <td className="muted-text">No state constituency loaded</td>
                              <td className="numeric">—</td>
                              <td className="numeric">{formatCount(federal.coordinators.length)}</td>
                            </tr>,
                          ]
                        : federal.stateConstituencies.map((stateConstituency, index) => (
                            <tr key={stateConstituency.id}>
                              {/* The federal constituency names its group once,
                                  rather than repeating on every child row. */}
                              <td>{index === 0 ? federal.name : ""}</td>
                              <td>{stateConstituency.name}</td>
                              <td className="numeric">{formatCount(stateConstituency.wards.length)}</td>
                              <td className="numeric">
                                {index === 0 ? formatCount(federal.coordinators.length) : ""}
                              </td>
                            </tr>
                          )),
                    )
                  )}
                </DataTable>
              </Panel>
            ))}
          </>
        ) : null}
      </div>
    </main>
  );
}
