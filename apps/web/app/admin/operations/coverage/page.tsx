"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AuthUserProfile, CoverageInsights } from "@pics-nigeria/shared";
import { ApiError, fetchAdminCoverageInsights, fetchCurrentUser, updateStateAgentTarget } from "../../../../lib/api";
import { AdminNav } from "../../../../components/admin-nav";
import { describeTerritory } from "../../../../components/admin-management-utils";
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
      <main className="shell">
        <section className="panel hero">
          <h1>Loading coverage insights...</h1>
        </section>
      </main>
    );
  }

  if (!user || !insights) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load coverage insights</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/admin/dashboard">Return to admin overview</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Field intelligence</p>
        <h1>Territory coverage</h1>
        <p>Visible scope: {describeTerritory(user.adminProfile || {
          geoPoliticalZoneId: null,
          stateId: null,
          senatorialDistrictId: null,
          federalConstituencyId: null,
          lgaId: null,
          wardId: null,
          stateConstituencyId: null,
          pollingUnitId: null,
        })}</p>
        <p className="muted">Coverage totals are restricted to your current authority. State and LGA inventory is authoritative. Ward, polling-unit, and staffing totals remain provisional until the full polling-unit reference dataset is loaded for this scope.</p>
      </section>

      <AdminNav role={user?.role} />
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}
      {insights.scopeWarning ? <p className="muted">{insights.scopeWarning}</p> : null}
      {insights.referenceData.inventoryWarning ? <p className="error">{insights.referenceData.inventoryWarning}</p> : null}

      <section className="grid stats">
        <article className="panel card">
          <h2>States in scope</h2>
          <div className="value">{insights.referenceData.authoritativeStates}</div>
        </article>
        <article className="panel card">
          <h2>LGAs in scope</h2>
          <div className="value">{insights.referenceData.authoritativeLgas}</div>
        </article>
        <article className="panel card">
          <h2>{inventoryComplete ? "Wards in scope" : "Loaded wards in scope"}</h2>
          <div className="value">{insights.referenceData.loadedWards}</div>
        </article>
        <article className="panel card">
          <h2>{inventoryComplete ? "Polling units in scope" : "Loaded polling units in scope"}</h2>
          <div className="value">{insights.summary.totalPollingUnitsInScope}</div>
        </article>
        <article className="panel card">
          <h2>Wards with coverage pressure</h2>
          <div className="value">{wardsNeedingAttention}</div>
        </article>
        <article className="panel card">
          <h2>Weak coverage</h2>
          <div className="value">{insights.summary.weakCoveragePollingUnits}</div>
        </article>
        <article className="panel card">
          <h2>No assigned agents</h2>
          <div className="value">{insights.summary.pollingUnitsWithoutAssignedAgents}</div>
        </article>
        <article className="panel card">
          <h2>No recent activity</h2>
          <div className="value">{insights.summary.pollingUnitsWithoutActivity}</div>
        </article>
        <article className="panel card">
          <h2>Open incident pressure</h2>
          <div className="value">{insights.summary.pollingUnitsWithIncidents}</div>
        </article>
        <article className="panel card">
          <h2>Agents missing polling unit</h2>
          <div className="value">{insights.summary.agentsWithoutPollingUnitAssignments}</div>
        </article>
        <article className="panel card">
          <h2>Loaded wards without polling units</h2>
          <div className="value">{insights.referenceData.loadedWardsWithoutPollingUnits}</div>
        </article>
        <article className="panel card">
          <h2>Assigned agents</h2>
          <div className="value">{insights.summary.assignedAgentsInScope}</div>
        </article>
        <article className="panel card">
          <h2>{inventoryComplete ? "Target agents" : "Loaded target agents"}</h2>
          <div className="value">{insights.summary.targetAgentsInScope}</div>
        </article>
        <article className="panel card">
          <h2>{inventoryComplete ? "Agents left to target" : "Loaded agents left"}</h2>
          <div className="value">{insights.summary.remainingAgentsToTarget}</div>
        </article>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Territory inventory</h2>
              <p className="muted">These are the reference counts the platform uses for staffing and coverage decisions in your visible territory. State and LGA totals are authoritative. Ward and polling-unit totals only become authoritative after the full reference dataset is loaded.</p>
            </div>
            <span className="status-pill">{inventoryComplete ? "Authoritative" : "Provisional"}</span>
          </div>
          <div className="reward-list">
            <article className="reward-item">
              <strong>States in scope</strong>
              <p className="muted">{insights.referenceData.authoritativeStates}</p>
            </article>
            <article className="reward-item">
              <strong>LGAs in scope</strong>
              <p className="muted">{insights.referenceData.authoritativeLgas}</p>
            </article>
            <article className="reward-item">
              <strong>{inventoryComplete ? "Wards in scope" : "Loaded wards in scope"}</strong>
              <p className="muted">{insights.referenceData.loadedWards}</p>
            </article>
            <article className="reward-item">
              <strong>{inventoryComplete ? "Polling units in scope" : "Loaded polling units in scope"}</strong>
              <p className="muted">{insights.referenceData.loadedPollingUnits}</p>
            </article>
            <article className="reward-item">
              <strong>Wards without polling units</strong>
              <p className="muted">{insights.referenceData.loadedWardsWithoutPollingUnits}</p>
            </article>
            <article className="reward-item">
              <strong>Synthetic bootstrap LGAs</strong>
              <p className="muted">{insights.referenceData.syntheticBootstrapLgas}</p>
            </article>
          </div>
        </section>

        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>State staffing targets</h2>
              <p className="muted">Target staffing is calculated from polling units currently loaded inside your visible territory. If no state target is set, the platform defaults to 1 agent per polling unit.</p>
            </div>
            <span className="status-pill">{inventoryComplete ? `${insights.stateTargets.length} states` : "Loaded reference only"}</span>
          </div>
          {insights.stateTargets.length === 0 ? (
            <p className="muted">No state staffing data is available in the current scope.</p>
          ) : (
            <div className="reward-list">
              {insights.stateTargets.map((stateTarget) => (
                <article key={stateTarget.stateId} className="reward-item">
                  <strong>{stateTarget.stateName}</strong>
                  <p className="muted">
                    Polling units in scope: {stateTarget.pollingUnitCount} | Current visible agents: {stateTarget.assignedAgentCount} | Target agents: {stateTarget.targetAgentCount}
                  </p>
                  <p className="muted">Agents left to target: {stateTarget.remainingAgentCount}</p>
                  {canSetTargets && canEditStateTarget(stateTarget.stateId) ? (
                    <div className="action-row" style={{ marginTop: 12 }}>
                      <input
                        type="number"
                        min={1}
                        value={stateTargetInputs[stateTarget.stateId] || ""}
                        onChange={(event) => setStateTargetInputs((current) => ({ ...current, [stateTarget.stateId]: event.target.value }))}
                        style={{ maxWidth: 120 }}
                      />
                      <button
                        className="button secondary"
                        type="button"
                        disabled={savingStateId === stateTarget.stateId}
                        onClick={() => void handleStateTargetSave(stateTarget.stateId)}
                      >
                        {savingStateId === stateTarget.stateId ? "Saving..." : "Set agents per PU"}
                      </button>
                    </div>
                  ) : (
                    <p className="muted">Configured target: {stateTarget.targetAgentsPerPollingUnit} agent(s) per polling unit.</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Agent assignment integrity</h2>
              <p className="muted">Agents should not be onboarded without a polling unit. This queue highlights any assignment gaps in scope.</p>
            </div>
            <span className="status-pill">{agentAssignmentGaps.length} agents</span>
          </div>
          {agentAssignmentGaps.length === 0 ? (
            <p className="muted">All visible agents are currently linked to polling units.</p>
          ) : (
            <div className="reward-list">
              {agentAssignmentGaps.map((agent) => (
                <article key={agent.userId} className="reward-item">
                  <strong>{agent.name}</strong>
                  <p>{agent.email}</p>
                  <p className="muted">
                    State: {agent.territory.stateId || "Not set"} | LGA: {agent.territory.lgaId || "Not set"} | Ward: {agent.territory.wardId || "Not set"}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Priority wards</h2>
              <p className="muted">Wards are sorted by missing agents, missing recent activity, and open incident pressure inside your current territory.</p>
            </div>
            <span className="status-pill">{insights.wards.length} wards</span>
          </div>
          {insights.wards.length === 0 ? (
            <p className="muted">No ward coverage data is available in the current scope.</p>
          ) : (
            <div className="reward-list">
              {insights.wards.slice(0, 12).map((ward) => (
                <article key={ward.wardId} className="reward-item">
                  <strong>{ward.wardName}</strong>
                  <p>{ward.lgaName}</p>
                  <p className="muted">
                    {ward.pollingUnitCount} polling units | {ward.assignedAgentCount} current agents | {ward.targetAgentCount} target agents
                  </p>
                  <p className="muted">{ward.remainingAgentCount} left to target | {ward.openIncidentCount} open incidents</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Polling units needing attention</h2>
              <p className="muted">These units currently have no assigned agents, no recent activity, or active incident pressure.</p>
            </div>
            <span className="status-pill">
              {insights.pollingUnits.filter((unit) => unit.requiresAttention).length} flagged
            </span>
          </div>
          {insights.pollingUnits.length === 0 ? (
            <p className="muted">No polling-unit coverage data is available in the current scope.</p>
          ) : (
            <div className="reward-list">
              {insights.pollingUnits.filter((unit) => unit.requiresAttention).slice(0, 16).map((unit) => (
                <article key={unit.pollingUnitId} className="reward-item">
                  <strong>{unit.pollingUnitName}</strong>
                  <p>{unit.wardName} | {unit.lgaName} | {unit.stateName}</p>
                  <p className="muted">
                    Agents: {unit.assignedAgentCount} of {unit.targetAgentCount} target | Recent signals: {unit.recentActivityCount} | Open incidents: {unit.openIncidentCount}
                  </p>
                  <p className="muted">
                    {unit.remainingAgentCount} left to target | {unit.hasRecentActivity ? "Recent activity present" : "No recent activity"}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Agent assignment gaps</h2>
              <p className="muted">Use this queue to identify wards and polling units that need agent coverage first.</p>
            </div>
            <span className="status-pill">{unitsWithoutAgents.length} units</span>
          </div>
          {unitsWithoutAgents.length === 0 ? (
            <p className="muted">All visible polling units currently have assigned agents.</p>
          ) : (
            <div className="reward-list">
              {wardsWithNoAgents.length ? wardsWithNoAgents.map((ward) => (
                <article key={`gap-${ward.wardId}`} className="reward-item">
                  <strong>{ward.wardName}</strong>
                  <p>{ward.lgaName}</p>
                  <p className="muted">{ward.pollingUnitsWithoutAgents} polling units without assigned agents</p>
                </article>
              )) : null}
            </div>
          )}
        </section>

        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Activity follow-up</h2>
              <p className="muted">These areas have visible polling units without recent field signals in the current window.</p>
            </div>
            <span className="status-pill">{unitsWithoutRecentActivity.length} units</span>
          </div>
          {unitsWithoutRecentActivity.length === 0 ? (
            <p className="muted">All visible polling units have recent field activity.</p>
          ) : (
            <div className="reward-list">
              {wardsWithNoRecentActivity.map((ward) => (
                <article key={`activity-${ward.wardId}`} className="reward-item">
                  <strong>{ward.wardName}</strong>
                  <p>{ward.lgaName}</p>
                  <p className="muted">{ward.pollingUnitsWithoutRecentActivity} polling units without recent activity</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Incident pressure</h2>
              <p className="muted">Polling units with open incident pressure should be checked against tasking and incident review.</p>
            </div>
            <span className="status-pill">{unitsWithIncidentPressure.length} units</span>
          </div>
          {unitsWithIncidentPressure.length === 0 ? (
            <p className="muted">No visible polling units currently carry open incident pressure.</p>
          ) : (
            <div className="reward-list">
              {unitsWithIncidentPressure.slice(0, 12).map((unit) => (
                <article key={`incident-${unit.pollingUnitId}`} className="reward-item">
                  <strong>{unit.pollingUnitName}</strong>
                  <p>{unit.wardName} | {unit.lgaName}</p>
                  <p className="muted">{unit.openIncidentCount} open incidents | {unit.assignedAgentCount} assigned agents</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
