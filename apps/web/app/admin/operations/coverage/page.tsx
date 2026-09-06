"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AuthUserProfile, CoverageInsights } from "@pics-nigeria/shared";
import { ApiError, fetchAdminCoverageInsights, fetchCurrentUser, updateStateAgentTarget } from "../../../../lib/api";
import { AdminNav } from "../../../../components/admin-nav";
import { describeTerritory } from "../../../../components/admin-management-utils";
import {
  DataTable,
  DetailList,
  EmptyRow,
  Kpi,
  KpiRow,
  Notice,
  PageHead,
  Panel,
  PanelGrid,
  StateView,
  formatCount,
} from "../../../../components/ui";
import { readSession } from "../../../../lib/session";

export default function AdminCoveragePage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [insights, setInsights] = useState<CoverageInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savingStateId, setSavingStateId] = useState("");
  const [stateTargetInputs, setStateTargetInputs] = useState<Record<string, string>>({});

  const unitsWithoutAgents = useMemo(
    () => insights?.pollingUnits.filter((unit) => !unit.hasAssignedAgent) || [],
    [insights],
  );
  const unitsWithoutRecentActivity = useMemo(
    () => insights?.pollingUnits.filter((unit) => !unit.hasRecentActivity) || [],
    [insights],
  );
  const unitsWithIncidentPressure = useMemo(
    () => insights?.pollingUnits.filter((unit) => unit.openIncidentCount > 0) || [],
    [insights],
  );
  const wardsWithNoAgents = useMemo(
    () => insights?.wards.filter((ward) => ward.pollingUnitsWithoutAgents > 0).slice(0, 8) || [],
    [insights],
  );
  const wardsWithNoRecentActivity = useMemo(
    () => insights?.wards.filter((ward) => ward.pollingUnitsWithoutRecentActivity > 0).slice(0, 8) || [],
    [insights],
  );
  const wardsNeedingAttention = useMemo(
    () =>
      insights?.wards.filter((ward) => ward.pollingUnitsWithoutAgents > 0 || ward.pollingUnitsWithoutRecentActivity > 0 || ward.openIncidentCount > 0)
        .length || 0,
    [insights],
  );
  const agentAssignmentGaps = insights?.agentsWithoutPollingUnitAssignments || [];
  const canSetTargets = user?.role === "SUPER_ADMIN" || user?.adminProfile?.adminLevel === "NATIONAL" || user?.adminProfile?.adminLevel === "STATE";
  const inventoryComplete = insights?.referenceData.wardAndPollingUnitInventoryComplete ?? false;

  function canEditStateTarget(stateId: string) {
    if (!user) {
      return false;
    }

    if (user.role === "SUPER_ADMIN") {
      return true;
    }

    if (user.adminProfile?.adminLevel === "NATIONAL") {
      return true;
    }

    if (user.adminProfile?.adminLevel === "STATE") {
      return user.adminProfile.stateId === stateId;
    }

    return false;
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    Promise.all([fetchCurrentUser(token), fetchAdminCoverageInsights(token)])
      .then(([currentUser, nextInsights]) => {
        if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
          throw new ApiError("This page is available to admins only.", 403);
        }

        setUser(currentUser);
        setInsights(nextInsights);
        setStateTargetInputs(
          Object.fromEntries(
            nextInsights.stateTargets.map((item) => [item.stateId, String(item.targetAgentsPerPollingUnit)]),
          ),
        );
      })
      .catch((caughtError) => setError(caughtError instanceof Error ? caughtError.message : "Could not load coverage insights."))
      .finally(() => setLoading(false));
  }, []);

  async function handleStateTargetSave(stateId: string) {
    const token = readSession();
    if (!token || !insights) {
      setError("Authentication is required.");
      return;
    }

    const rawValue = stateTargetInputs[stateId];
    const parsedValue = Number(rawValue);
    if (!Number.isInteger(parsedValue) || parsedValue < 1) {
      setError("Agents per polling unit must be at least 1.");
      return;
    }

    try {
      setSavingStateId(stateId);
      setError("");
      setMessage("");
      const result = await updateStateAgentTarget(token, stateId, parsedValue);
      const nextInsights = await fetchAdminCoverageInsights(token);
      setInsights(nextInsights);
      setStateTargetInputs(
        Object.fromEntries(
          nextInsights.stateTargets.map((item) => [item.stateId, String(item.targetAgentsPerPollingUnit)]),
        ),
      );
      setMessage(result.message);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not update the state staffing target.");
    } finally {
      setSavingStateId("");
    }
  }
  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Territory coverage" />
        <StateView kind="loading" title="Loading coverage insights…" />
      </main>
    );
  }

  if (!user || !insights) {
    return (
      <main className="console-shell">
        <PageHead title="Territory coverage" />
        <StateView
          kind="error"
          title="Unable to load coverage insights"
          detail={error || "Authentication is required."}
          action={
            <Link className="btn btn-primary" href="/admin/dashboard">
              Return to admin overview
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <main className="console-shell">
      <PageHead
        title="Territory coverage"
        lead={`Visible scope: ${describeTerritory(
          user.adminProfile || {
            geoPoliticalZoneId: null,
            stateId: null,
            senatorialDistrictId: null,
            federalConstituencyId: null,
            lgaId: null,
            wardId: null,
            stateConstituencyId: null,
            pollingUnitId: null,
          },
        )}`}
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        {error ? <Notice tone="error" title="Something went wrong">{error}</Notice> : null}
        {message ? <Notice tone="ok" title={message} /> : null}
        {insights.referenceData.inventoryWarning ? (
          <Notice tone="legacy" title="Reference inventory is incomplete">
            <span>{insights.referenceData.inventoryWarning}</span>
          </Notice>
        ) : null}
        {insights.scopeWarning ? (
          <Notice tone="legacy" title="Scope note">
            <span>{insights.scopeWarning}</span>
          </Notice>
        ) : null}

        {/*
          These were fourteen equally weighted tiles, six of which the Territory
          inventory panel below then repeated verbatim. What an operator acts on
          is the gap between what is staffed and what is not, so only the gaps
          are primary; the reference counts stay in the inventory panel that
          already carried them.
        */}
        <KpiRow>
          <Kpi
            label={inventoryComplete ? "Polling Units in scope" : "Loaded Polling Units"}
            value={formatCount(insights.summary.totalPollingUnitsInScope)}
            note={inventoryComplete ? "Authoritative inventory" : "Provisional until the full reference set loads"}
          />
          <Kpi
            label="Without assigned agents"
            value={formatCount(insights.summary.pollingUnitsWithoutAssignedAgents)}
            note="Staff these first"
            tone={insights.summary.pollingUnitsWithoutAssignedAgents > 0 ? "warn" : undefined}
          />
          <Kpi
            label="Without recent activity"
            value={formatCount(insights.summary.pollingUnitsWithoutActivity)}
            note="No field signal in the current window"
            tone={insights.summary.pollingUnitsWithoutActivity > 0 ? "warn" : undefined}
          />
          <Kpi
            label="Open incident pressure"
            value={formatCount(insights.summary.pollingUnitsWithIncidents)}
            tone={insights.summary.pollingUnitsWithIncidents > 0 ? "warn" : undefined}
          />
          <Kpi
            label="Agents left to target"
            value={formatCount(insights.summary.remainingAgentsToTarget)}
            note={`${formatCount(insights.summary.assignedAgentsInScope)} assigned of ${formatCount(insights.summary.targetAgentsInScope)} target`}
            tone={insights.summary.remainingAgentsToTarget > 0 ? "accent" : undefined}
          />
        </KpiRow>

        <PanelGrid>
          <Panel
            title="Territory inventory"
            meta={inventoryComplete ? "Authoritative" : "Provisional"}
          >
            <div className="stack-3">
              <p className="muted-text">
                The reference counts the platform uses for staffing decisions. State and LGA totals are authoritative.
                Ward and Polling Unit totals become authoritative only once the full reference dataset is loaded.
              </p>
              <DetailList
                rows={[
                  { label: "States", value: formatCount(insights.referenceData.authoritativeStates) },
                  { label: "LGAs", value: formatCount(insights.referenceData.authoritativeLgas) },
                  {
                    label: inventoryComplete ? "Wards" : "Loaded wards",
                    value: formatCount(insights.referenceData.loadedWards),
                  },
                  {
                    label: inventoryComplete ? "Polling Units" : "Loaded Polling Units",
                    value: formatCount(insights.referenceData.loadedPollingUnits),
                  },
                  {
                    label: "Wards without Polling Units",
                    value: formatCount(insights.referenceData.loadedWardsWithoutPollingUnits),
                  },
                  {
                    label: "Synthetic bootstrap LGAs",
                    value: formatCount(insights.referenceData.syntheticBootstrapLgas),
                  },
                  { label: "Wards under pressure", value: formatCount(wardsNeedingAttention) },
                  { label: "Weak coverage units", value: formatCount(insights.summary.weakCoveragePollingUnits) },
                  {
                    label: "Agents with no Polling Unit",
                    value: formatCount(insights.summary.agentsWithoutPollingUnitAssignments),
                  },
                ]}
              />
            </div>
          </Panel>

          <Panel
            title="State staffing targets"
            meta={inventoryComplete ? `${formatCount(insights.stateTargets.length)} states` : "Loaded reference only"}
            flush
          >
            <div className="panel-body">
              <p className="muted-text">
                Targets are calculated from Polling Units currently loaded inside your visible territory. With no state
                target set, the platform defaults to one agent per Polling Unit.
              </p>
            </div>
            <DataTable
              head={
                <tr>
                  <th>State</th>
                  <th className="numeric">Polling Units</th>
                  <th className="numeric">Agents</th>
                  <th className="numeric">Target</th>
                  <th className="numeric">Left</th>
                  <th className="actions">Agents per PU</th>
                </tr>
              }
            >
              {insights.stateTargets.length === 0 ? (
                <EmptyRow colSpan={6}>No state staffing data in the current scope.</EmptyRow>
              ) : (
                insights.stateTargets.map((stateTarget) => (
                  <tr key={stateTarget.stateId}>
                    <td>{stateTarget.stateName}</td>
                    <td className="numeric">{formatCount(stateTarget.pollingUnitCount)}</td>
                    <td className="numeric">{formatCount(stateTarget.assignedAgentCount)}</td>
                    <td className="numeric">{formatCount(stateTarget.targetAgentCount)}</td>
                    <td className="numeric">{formatCount(stateTarget.remainingAgentCount)}</td>
                    <td className="actions">
                      {canSetTargets && canEditStateTarget(stateTarget.stateId) ? (
                        <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                          <label className="sr-only" htmlFor={`target-${stateTarget.stateId}`}>
                            Agents per Polling Unit for {stateTarget.stateName}
                          </label>
                          <input
                            id={`target-${stateTarget.stateId}`}
                            type="number"
                            min={1}
                            style={{ maxWidth: "5rem" }}
                            value={stateTargetInputs[stateTarget.stateId] || ""}
                            onChange={(event) =>
                              setStateTargetInputs((current) => ({ ...current, [stateTarget.stateId]: event.target.value }))
                            }
                          />
                          <button
                            className="btn btn-sm"
                            type="button"
                            disabled={savingStateId === stateTarget.stateId}
                            onClick={() => void handleStateTargetSave(stateTarget.stateId)}
                          >
                            {savingStateId === stateTarget.stateId ? "Saving…" : "Set"}
                          </button>
                        </span>
                      ) : (
                        <span className="muted-text">{stateTarget.targetAgentsPerPollingUnit} per unit</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>
        </PanelGrid>

        <PanelGrid wide>
          <Panel title="Priority wards" meta={`${formatCount(insights.wards.length)} wards`} flush>
            <div className="panel-body">
              <p className="muted-text">
                Sorted by missing agents, missing recent activity and open incident pressure inside your territory.
              </p>
            </div>
            <DataTable
              head={
                <tr>
                  <th>Ward</th>
                  <th>LGA</th>
                  <th className="numeric">Units</th>
                  <th className="numeric">Agents</th>
                  <th className="numeric">Target</th>
                  <th className="numeric">Left</th>
                  <th className="numeric">Incidents</th>
                </tr>
              }
            >
              {insights.wards.length === 0 ? (
                <EmptyRow colSpan={7}>No ward coverage data in the current scope.</EmptyRow>
              ) : (
                insights.wards.slice(0, 20).map((ward) => (
                  <tr key={ward.wardId}>
                    <td>{ward.wardName}</td>
                    <td className="muted-text">{ward.lgaName}</td>
                    <td className="numeric">{formatCount(ward.pollingUnitCount)}</td>
                    <td className="numeric">{formatCount(ward.assignedAgentCount)}</td>
                    <td className="numeric">{formatCount(ward.targetAgentCount)}</td>
                    <td className="numeric">{formatCount(ward.remainingAgentCount)}</td>
                    <td className="numeric">{formatCount(ward.openIncidentCount)}</td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>

          <Panel
            title="Polling Units needing attention"
            meta={`${formatCount(insights.pollingUnits.filter((unit) => unit.requiresAttention).length)} flagged`}
            flush
          >
            <DataTable
              head={
                <tr>
                  <th>Polling Unit</th>
                  <th>Ward / LGA</th>
                  <th className="numeric">Agents</th>
                  <th className="numeric">Signals</th>
                  <th className="numeric">Incidents</th>
                </tr>
              }
            >
              {insights.pollingUnits.filter((unit) => unit.requiresAttention).length === 0 ? (
                <EmptyRow colSpan={5}>No Polling Unit currently needs attention in this scope.</EmptyRow>
              ) : (
                insights.pollingUnits
                  .filter((unit) => unit.requiresAttention)
                  .slice(0, 20)
                  .map((unit) => (
                    <tr key={unit.pollingUnitId}>
                      <td>
                        {unit.pollingUnitName}
                        {!unit.hasRecentActivity ? (
                          <div>
                            <span className="pill pill-refused">no recent activity</span>
                          </div>
                        ) : null}
                      </td>
                      <td className="muted-text">
                        {unit.wardName} · {unit.lgaName}
                      </td>
                      <td className="numeric">
                        {formatCount(unit.assignedAgentCount)} / {formatCount(unit.targetAgentCount)}
                      </td>
                      <td className="numeric">{formatCount(unit.recentActivityCount)}</td>
                      <td className="numeric">{formatCount(unit.openIncidentCount)}</td>
                    </tr>
                  ))
              )}
            </DataTable>
          </Panel>
        </PanelGrid>

        <PanelGrid>
          <Panel title="Agent assignment integrity" meta={`${formatCount(agentAssignmentGaps.length)} agents`} flush>
            <div className="panel-body">
              <p className="muted-text">An agent should not be onboarded without a Polling Unit.</p>
            </div>
            <DataTable
              head={
                <tr>
                  <th>Agent</th>
                  <th>State</th>
                  <th>LGA</th>
                  <th>Ward</th>
                </tr>
              }
            >
              {agentAssignmentGaps.length === 0 ? (
                <EmptyRow colSpan={4}>All visible agents are linked to a Polling Unit.</EmptyRow>
              ) : (
                agentAssignmentGaps.map((agent) => (
                  <tr key={agent.userId}>
                    <td>
                      <strong>{agent.name}</strong>
                      <div className="muted-text">{agent.email}</div>
                    </td>
                    <td className="muted-text">{agent.territory.stateId || "Not set"}</td>
                    <td className="muted-text">{agent.territory.lgaId || "Not set"}</td>
                    <td className="muted-text">{agent.territory.wardId || "Not set"}</td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>

          <Panel title="Wards to staff first" meta={`${formatCount(unitsWithoutAgents.length)} units`} flush>
            <DataTable
              head={
                <tr>
                  <th>Ward</th>
                  <th>LGA</th>
                  <th className="numeric">Units without agents</th>
                </tr>
              }
            >
              {wardsWithNoAgents.length === 0 ? (
                <EmptyRow colSpan={3}>All visible Polling Units have assigned agents.</EmptyRow>
              ) : (
                wardsWithNoAgents.map((ward) => (
                  <tr key={`gap-${ward.wardId}`}>
                    <td>{ward.wardName}</td>
                    <td className="muted-text">{ward.lgaName}</td>
                    <td className="numeric">{formatCount(ward.pollingUnitsWithoutAgents)}</td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>

          <Panel title="Activity follow-up" meta={`${formatCount(unitsWithoutRecentActivity.length)} units`} flush>
            <DataTable
              head={
                <tr>
                  <th>Ward</th>
                  <th>LGA</th>
                  <th className="numeric">Units without signal</th>
                </tr>
              }
            >
              {wardsWithNoRecentActivity.length === 0 ? (
                <EmptyRow colSpan={3}>All visible Polling Units have recent field activity.</EmptyRow>
              ) : (
                wardsWithNoRecentActivity.map((ward) => (
                  <tr key={`activity-${ward.wardId}`}>
                    <td>{ward.wardName}</td>
                    <td className="muted-text">{ward.lgaName}</td>
                    <td className="numeric">{formatCount(ward.pollingUnitsWithoutRecentActivity)}</td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>

          <Panel title="Incident pressure" meta={`${formatCount(unitsWithIncidentPressure.length)} units`} flush>
            <DataTable
              head={
                <tr>
                  <th>Polling Unit</th>
                  <th>Ward / LGA</th>
                  <th className="numeric">Open</th>
                  <th className="numeric">Agents</th>
                </tr>
              }
            >
              {unitsWithIncidentPressure.length === 0 ? (
                <EmptyRow colSpan={4}>No visible Polling Unit carries open incident pressure.</EmptyRow>
              ) : (
                unitsWithIncidentPressure.slice(0, 15).map((unit) => (
                  <tr key={`incident-${unit.pollingUnitId}`}>
                    <td>{unit.pollingUnitName}</td>
                    <td className="muted-text">
                      {unit.wardName} · {unit.lgaName}
                    </td>
                    <td className="numeric">{formatCount(unit.openIncidentCount)}</td>
                    <td className="numeric">{formatCount(unit.assignedAgentCount)}</td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>
        </PanelGrid>
      </div>
    </main>
  );
}
