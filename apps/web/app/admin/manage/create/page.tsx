"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ADMIN_LEVELS, CANDIDATE_OFFICE_TYPES, emptyTerritorySummary } from "@pics-nigeria/shared";
import type {
  AdminUserItem,
  AgentUserItem,
  AuthUserProfile,
  CandidateListItem,
  FederalConstituencyItem,
  LgaItem,
  PollingUnitItem,
  PoliticalPartyItem,
  SenatorialDistrictItem,
  StateConstituencyItem,
  StateItem,
  WardItem,
} from "@pics-nigeria/shared";
import {
  ApiError,
  createAdminUser,
  createAgent,
  createCandidate,
  fetchAdminCandidates,
  fetchAdminUsers,
  fetchAgents,
  fetchCurrentUser,
  fetchFederalConstituencies,
  fetchLgas,
  fetchPollingUnits,
  fetchPoliticalParties,
  fetchSenatorialDistricts,
  fetchStates,
  fetchStateConstituencies,
  fetchWards,
  updateAdminUser,
  updateAgent,
  updateCandidate,
} from "../../../../lib/api";
import { AdminNav } from "../../../../components/admin-nav";
import { describeTerritory } from "../../../../components/admin-management-utils";
import { readSession } from "../../../../lib/session";

type ManagedRole = "ADMIN" | "CANDIDATE" | "AGENT";
type PageMode = "create" | "edit";

const adminLevelRank: Record<(typeof ADMIN_LEVELS)[number], number> = {
  NATIONAL: 7,
  GEO_POLITICAL_ZONE: 6,
  STATE: 5,
  SENATORIAL: 4,
  FEDERAL_CONSTITUENCY: 3,
  STATE_CONSTITUENCY: 2,
  LGA: 1,
  WARD: 0,
};

const candidateOfficeRank: Record<(typeof CANDIDATE_OFFICE_TYPES)[number], number> = {
  PRESIDENTIAL: 7,
  GOVERNORSHIP: 5,
  SENATE: 4,
  HOUSE_OF_REP: 3,
  STATE_ASSEMBLY: 2,
  CHAIRMANSHIP: 1,
  COUNCILLOR: 0,
};

function baseTerritory() {
  return {
    stateId: "",
    senatorialDistrictId: "",
    federalConstituencyId: "",
    lgaId: "",
    wardId: "",
    stateConstituencyId: "",
  };
}

export default function AdminManageCreatePage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [admins, setAdmins] = useState<AdminUserItem[]>([]);
  const [candidates, setCandidates] = useState<CandidateListItem[]>([]);
  const [agents, setAgents] = useState<AgentUserItem[]>([]);
  const [parties, setParties] = useState<PoliticalPartyItem[]>([]);
  const [states, setStates] = useState<StateItem[]>([]);
  const [districts, setDistricts] = useState<SenatorialDistrictItem[]>([]);
  const [federalConstituencies, setFederalConstituencies] = useState<FederalConstituencyItem[]>([]);
  const [lgas, setLgas] = useState<LgaItem[]>([]);
  const [wards, setWards] = useState<WardItem[]>([]);
  const [pollingUnits, setPollingUnits] = useState<PollingUnitItem[]>([]);
  const [stateConstituencies, setStateConstituencies] = useState<StateConstituencyItem[]>([]);
  const [mode, setMode] = useState<PageMode>("create");
  const [role, setRole] = useState<ManagedRole>("ADMIN");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [adminForm, setAdminForm] = useState({
    name: "",
    email: "",
    password: "",
    adminLevel: "STATE" as (typeof ADMIN_LEVELS)[number],
    politicalPartyId: "",
    ...baseTerritory(),
  });
  const [candidateForm, setCandidateForm] = useState({
    name: "",
    email: "",
    password: "",
    officeType: "GOVERNORSHIP" as (typeof CANDIDATE_OFFICE_TYPES)[number],
    politicalPartyId: "",
    ...baseTerritory(),
  });
  const [agentForm, setAgentForm] = useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    politicalPartyId: "",
    pollingUnitId: "",
    ...baseTerritory(),
  });

  const manageableAdminLevels = useMemo(() => {
    // Features 001 and 003: the platform is Ogun-only and LGA is reference
    // data, not a command level. NATIONAL and GEO_POLITICAL_ZONE describe a
    // hierarchy above the state that no longer exists here, and LGA describes
    // authority the constituency-first structure does not grant — offering any
    // of the three creates an operator the command model cannot place.
    const assignable = ADMIN_LEVELS.filter(
      (level) => level !== "NATIONAL" && level !== "GEO_POLITICAL_ZONE" && level !== "LGA",
    );
    if (!user?.adminProfile || user.role === "SUPER_ADMIN") {
      return assignable;
    }
    return assignable.filter((level) => adminLevelRank[user.adminProfile!.adminLevel] > adminLevelRank[level]);
  }, [user]);

  const manageableCandidateOffices = useMemo(() => {
    if (!user?.adminProfile || user.role === "SUPER_ADMIN") {
      return CANDIDATE_OFFICE_TYPES;
    }
    return CANDIDATE_OFFICE_TYPES.filter((office) => adminLevelRank[user.adminProfile!.adminLevel] >= candidateOfficeRank[office]);
  }, [user]);

  async function refreshLookups(token: string, stateId?: string, lgaId?: string, senatorialDistrictId?: string, wardId?: string) {
    if (!stateId) {
      setDistricts([]);
      setFederalConstituencies([]);
      setLgas([]);
      setWards([]);
      setPollingUnits([]);
      setStateConstituencies([]);
      return;
    }

    const [nextDistricts, nextFederal, nextLgas, nextStateConstituencies, nextWards, nextPollingUnits] = await Promise.all([
      fetchSenatorialDistricts(token, stateId),
      fetchFederalConstituencies(token, stateId, senatorialDistrictId || undefined),
      fetchLgas(token, stateId),
      fetchStateConstituencies(token, stateId, lgaId || undefined),
      lgaId ? fetchWards(token, stateId, lgaId) : Promise.resolve([]),
      lgaId && wardId ? fetchPollingUnits(token, stateId, lgaId, wardId) : Promise.resolve([]),
    ]);

    setDistricts(nextDistricts);
    setFederalConstituencies(nextFederal);
    setLgas(nextLgas);
    setStateConstituencies(nextStateConstituencies);
    setWards(nextWards);
    setPollingUnits(nextPollingUnits);
  }

  async function hydrate(token: string) {
    const [currentUser, nextParties, nextStates, nextAdmins, nextCandidates, nextAgents] = await Promise.all([
      fetchCurrentUser(token),
      fetchPoliticalParties(token),
      fetchStates(token),
      fetchAdminUsers(token, ""),
      fetchAdminCandidates(token),
      fetchAgents(token),
    ]);

    if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
      throw new ApiError("This page is available to admins only.", 403);
    }

    setUser(currentUser);
    setParties(nextParties);
    setStates(nextStates);
    setAdmins(nextAdmins);
    setCandidates(nextCandidates);
    setAgents(nextAgents);

    const params = new URLSearchParams(window.location.search);
    const nextMode = (params.get("mode") as PageMode) || "create";
    const nextRole = (params.get("role") as ManagedRole) || "ADMIN";
    const nextUserId = params.get("userId") || "";
    const locatorStateId = params.get("stateId") || currentUser.adminProfile?.stateId || "";
    const locatorLgaId = params.get("lgaId") || currentUser.adminProfile?.lgaId || "";
    const locatorWardId = params.get("wardId") || currentUser.adminProfile?.wardId || "";
    setMode(nextMode);
    setRole(nextRole);
    setSelectedUserId(nextUserId);

    const actorPartyId = currentUser.role === "ADMIN" ? currentUser.adminProfile?.politicalPartyId || "" : "";
    if (actorPartyId) {
      setAdminForm((current) => ({ ...current, politicalPartyId: actorPartyId }));
      setCandidateForm((current) => ({ ...current, politicalPartyId: actorPartyId }));
      setAgentForm((current) => ({ ...current, politicalPartyId: actorPartyId }));
    }

    if (nextMode === "create") {
      setAdminForm((current) => ({ ...current, stateId: locatorStateId, lgaId: locatorLgaId, wardId: locatorWardId }));
      setCandidateForm((current) => ({ ...current, stateId: locatorStateId, lgaId: locatorLgaId, wardId: locatorWardId }));
      setAgentForm((current) => ({ ...current, stateId: locatorStateId, lgaId: locatorLgaId, wardId: locatorWardId }));
      if (locatorStateId) {
        await refreshLookups(token, locatorStateId, locatorLgaId || undefined, undefined, locatorWardId || undefined);
      }
    }

    if (nextMode !== "edit" || !nextUserId) {
      return;
    }

    if (nextRole === "ADMIN") {
      const target = nextAdmins.find((item) => item.userId === nextUserId);
      if (target) {
        setAdminForm({
          name: target.name,
          email: target.email,
          password: "",
          adminLevel: target.adminLevel,
          politicalPartyId: target.politicalPartyId || actorPartyId,
          stateId: target.territory.stateId || "",
          senatorialDistrictId: target.territory.senatorialDistrictId || "",
          federalConstituencyId: target.territory.federalConstituencyId || "",
          lgaId: target.territory.lgaId || "",
          wardId: target.territory.wardId || "",
          stateConstituencyId: target.territory.stateConstituencyId || "",
        });
        await refreshLookups(
          token,
          target.territory.stateId || undefined,
          target.territory.lgaId || undefined,
          target.territory.senatorialDistrictId || undefined,
          target.territory.wardId || undefined,
        );
      }
    }

    if (nextRole === "CANDIDATE") {
      const target = nextCandidates.find((item) => item.userId === nextUserId);
      if (target) {
        setCandidateForm({
          name: target.name,
          email: target.email,
          password: "",
          officeType: target.officeType,
          politicalPartyId: target.politicalPartyId || actorPartyId,
          stateId: target.territory.stateId || "",
          senatorialDistrictId: target.territory.senatorialDistrictId || "",
          federalConstituencyId: target.territory.federalConstituencyId || "",
          lgaId: target.territory.lgaId || "",
          wardId: target.territory.wardId || "",
          stateConstituencyId: target.territory.stateConstituencyId || "",
        });
        await refreshLookups(
          token,
          target.territory.stateId || undefined,
          target.territory.lgaId || undefined,
          target.territory.senatorialDistrictId || undefined,
          target.territory.wardId || undefined,
        );
      }
    }

    if (nextRole === "AGENT") {
      const target = nextAgents.find((item) => item.userId === nextUserId);
      if (target) {
        setAgentForm({
          name: target.name,
          email: target.email,
          password: "",
          phone: target.phone || "",
          politicalPartyId: target.politicalPartyId || actorPartyId,
          pollingUnitId: target.territory.pollingUnitId || "",
          stateId: target.territory.stateId || "",
          senatorialDistrictId: target.territory.senatorialDistrictId || "",
          federalConstituencyId: target.territory.federalConstituencyId || "",
          lgaId: target.territory.lgaId || "",
          wardId: target.territory.wardId || "",
          stateConstituencyId: target.territory.stateConstituencyId || "",
        });
        await refreshLookups(
          token,
          target.territory.stateId || undefined,
          target.territory.lgaId || undefined,
          target.territory.senatorialDistrictId || undefined,
          target.territory.wardId || undefined,
        );
      }
    }
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    hydrate(token)
      .catch((caughtError) => setError(caughtError instanceof Error ? caughtError.message : "Could not load user workflow."))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    try {
      setSaving(true);
      setError("");
      setMessage("");

      if (role === "ADMIN") {
        const result: { message: string } = mode === "create"
          ? await createAdminUser(token, adminForm)
          : await updateAdminUser(token, selectedUserId, {
            name: adminForm.name,
            adminLevel: adminForm.adminLevel,
            politicalPartyId: adminForm.politicalPartyId,
            stateId: adminForm.stateId,
            senatorialDistrictId: adminForm.senatorialDistrictId,
            federalConstituencyId: adminForm.federalConstituencyId,
            lgaId: adminForm.lgaId,
            wardId: adminForm.wardId,
            stateConstituencyId: adminForm.stateConstituencyId,
          });
        setMessage(result.message);
      }

      if (role === "CANDIDATE") {
        const result: { message: string } = mode === "create"
          ? await createCandidate(token, candidateForm)
          : await updateCandidate(token, selectedUserId, {
            name: candidateForm.name,
            officeType: candidateForm.officeType,
            politicalPartyId: candidateForm.politicalPartyId,
            stateId: candidateForm.stateId,
            senatorialDistrictId: candidateForm.senatorialDistrictId,
            federalConstituencyId: candidateForm.federalConstituencyId,
            lgaId: candidateForm.lgaId,
            wardId: candidateForm.wardId,
            stateConstituencyId: candidateForm.stateConstituencyId,
          });
        setMessage(result.message);
      }

      if (role === "AGENT") {
        if (!agentForm.politicalPartyId) {
          throw new Error("Each agent must be linked to a political party.");
        }
        if (!agentForm.pollingUnitId) {
          throw new Error("Each agent must be assigned to a polling unit.");
        }

        const result: { message: string } = mode === "create"
          ? await createAgent(token, agentForm)
          : await updateAgent(token, selectedUserId, {
            name: agentForm.name,
            phone: agentForm.phone,
            politicalPartyId: agentForm.politicalPartyId,
            stateId: agentForm.stateId,
            senatorialDistrictId: agentForm.senatorialDistrictId,
            federalConstituencyId: agentForm.federalConstituencyId,
            lgaId: agentForm.lgaId,
            wardId: agentForm.wardId,
            stateConstituencyId: agentForm.stateConstituencyId,
            pollingUnitId: agentForm.pollingUnitId,
          });
        setMessage(result.message);
      }

      await hydrate(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not save user.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="shell">
        <section className="panel hero">
          <h1>Loading create user workflow...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load user workflow</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/admin/manage">Return to management</Link>
        </section>
      </main>
    );
  }

  const currentPartyId = user.role === "ADMIN" ? user.adminProfile?.politicalPartyId || "" : "";

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Territory-first user workflow</p>
        <h1>{mode === "create" ? "Create user" : "Edit user"}</h1>
        <p>Authority scope: {describeTerritory(user.adminProfile || emptyTerritorySummary())}</p>
      </section>

      <AdminNav role={user?.role} />
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      <section className="panel card">
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label className="field">
            <span>Action</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as PageMode)}>
              <option value="create">Create new user</option>
              <option value="edit">Edit existing user</option>
            </select>
          </label>
          <label className="field">
            <span>User type</span>
            <select value={role} onChange={(event) => setRole(event.target.value as ManagedRole)}>
              <option value="ADMIN">Admin</option>
              <option value="CANDIDATE">Candidate</option>
              <option value="AGENT">Agent</option>
            </select>
          </label>
          {mode === "edit" ? (
            <label className="field">
              <span>Select user</span>
              <select value={selectedUserId} onChange={(event) => {
                const params = new URLSearchParams({ mode: "edit", role, userId: event.target.value });
                window.location.href = `/admin/manage/create?${params.toString()}`;
              }}>
                <option value="">Select user</option>
                {role === "ADMIN" ? admins.map((item) => <option key={item.userId} value={item.userId}>{item.name}</option>) : null}
                {role === "CANDIDATE" ? candidates.map((item) => <option key={item.userId} value={item.userId}>{item.name}</option>) : null}
                {role === "AGENT" ? agents.map((item) => <option key={item.userId} value={item.userId}>{item.name}</option>) : null}
              </select>
            </label>
          ) : null}
        </div>
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <div className="form">
          {role === "ADMIN" ? (
            <>
              <label className="field"><span>Name</span><input value={adminForm.name} onChange={(event) => setAdminForm({ ...adminForm, name: event.target.value })} /></label>
              <label className="field"><span>Email</span><input type="email" value={adminForm.email} onChange={(event) => setAdminForm({ ...adminForm, email: event.target.value })} disabled={mode === "edit"} /></label>
              <label className="field"><span>Password</span><input type="password" value={adminForm.password} onChange={(event) => setAdminForm({ ...adminForm, password: event.target.value })} disabled={mode === "edit"} /></label>
              <label className="field"><span>Admin level</span><select value={adminForm.adminLevel} onChange={(event) => setAdminForm({ ...adminForm, adminLevel: event.target.value as (typeof ADMIN_LEVELS)[number] })}>{manageableAdminLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
              <label className="field"><span>Political party</span><select value={adminForm.politicalPartyId} onChange={(event) => setAdminForm({ ...adminForm, politicalPartyId: event.target.value })} disabled={Boolean(currentPartyId)}><option value="">Select party</option>{parties.map((party) => <option key={party.id} value={party.id}>{party.code} - {party.name}</option>)}</select></label>
            </>
          ) : null}

          {role === "CANDIDATE" ? (
            <>
              <label className="field"><span>Name</span><input value={candidateForm.name} onChange={(event) => setCandidateForm({ ...candidateForm, name: event.target.value })} /></label>
              <label className="field"><span>Email</span><input type="email" value={candidateForm.email} onChange={(event) => setCandidateForm({ ...candidateForm, email: event.target.value })} disabled={mode === "edit"} /></label>
              <label className="field"><span>Password</span><input type="password" value={candidateForm.password} onChange={(event) => setCandidateForm({ ...candidateForm, password: event.target.value })} disabled={mode === "edit"} /></label>
              <label className="field"><span>Office</span><select value={candidateForm.officeType} onChange={(event) => setCandidateForm({ ...candidateForm, officeType: event.target.value as (typeof CANDIDATE_OFFICE_TYPES)[number] })}>{manageableCandidateOffices.map((office) => <option key={office} value={office}>{office}</option>)}</select></label>
              <label className="field"><span>Political party</span><select value={candidateForm.politicalPartyId} onChange={(event) => setCandidateForm({ ...candidateForm, politicalPartyId: event.target.value })} disabled={Boolean(currentPartyId)}><option value="">Select party</option>{parties.map((party) => <option key={party.id} value={party.id}>{party.code} - {party.name}</option>)}</select></label>
            </>
          ) : null}

          {role === "AGENT" ? (
            <>
              <label className="field"><span>Name</span><input value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} /></label>
              <label className="field"><span>Email</span><input type="email" value={agentForm.email} onChange={(event) => setAgentForm({ ...agentForm, email: event.target.value })} disabled={mode === "edit"} /></label>
              <label className="field"><span>Password</span><input type="password" value={agentForm.password} onChange={(event) => setAgentForm({ ...agentForm, password: event.target.value })} disabled={mode === "edit"} /></label>
              <label className="field"><span>Phone</span><input value={agentForm.phone} onChange={(event) => setAgentForm({ ...agentForm, phone: event.target.value })} /></label>
              <label className="field"><span>Political party</span><select value={agentForm.politicalPartyId} onChange={(event) => setAgentForm({ ...agentForm, politicalPartyId: event.target.value })} disabled={Boolean(currentPartyId)}><option value="">Select party</option>{parties.map((party) => <option key={party.id} value={party.id}>{party.code} - {party.name}</option>)}</select></label>
            </>
          ) : null}

          <label className="field">
            <span>State</span>
            <select value={role === "ADMIN" ? adminForm.stateId : role === "CANDIDATE" ? candidateForm.stateId : agentForm.stateId} onChange={async (event) => {
              const token = readSession();
              if (!token) { return; }
              const stateId = event.target.value;
              await refreshLookups(token, stateId);
              if (role === "ADMIN") { setAdminForm({ ...adminForm, ...baseTerritory(), stateId, politicalPartyId: adminForm.politicalPartyId, adminLevel: adminForm.adminLevel, name: adminForm.name, email: adminForm.email, password: adminForm.password }); }
              if (role === "CANDIDATE") { setCandidateForm({ ...candidateForm, ...baseTerritory(), stateId, politicalPartyId: candidateForm.politicalPartyId, officeType: candidateForm.officeType, name: candidateForm.name, email: candidateForm.email, password: candidateForm.password }); }
              if (role === "AGENT") { setAgentForm({ ...agentForm, ...baseTerritory(), stateId, pollingUnitId: "", politicalPartyId: agentForm.politicalPartyId, name: agentForm.name, email: agentForm.email, password: agentForm.password, phone: agentForm.phone }); }
            }}>
              <option value="">Select state</option>
              {states.filter((item) => !user.adminProfile?.stateId || item.id === user.adminProfile.stateId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>

          <label className="field">
            <span>Senatorial district</span>
            <select value={role === "ADMIN" ? adminForm.senatorialDistrictId : role === "CANDIDATE" ? candidateForm.senatorialDistrictId : agentForm.senatorialDistrictId} onChange={async (event) => {
              const token = readSession();
              if (!token) { return; }
              const value = event.target.value;
              const currentStateId = role === "ADMIN" ? adminForm.stateId : role === "CANDIDATE" ? candidateForm.stateId : agentForm.stateId;
              await refreshLookups(token, currentStateId, role === "ADMIN" ? adminForm.lgaId : role === "CANDIDATE" ? candidateForm.lgaId : agentForm.lgaId, value);
              if (role === "ADMIN") { setAdminForm({ ...adminForm, senatorialDistrictId: value, federalConstituencyId: "" }); }
              if (role === "CANDIDATE") { setCandidateForm({ ...candidateForm, senatorialDistrictId: value, federalConstituencyId: "" }); }
              if (role === "AGENT") { setAgentForm({ ...agentForm, senatorialDistrictId: value, federalConstituencyId: "" }); }
            }}>
              <option value="">Unspecified</option>
              {districts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>

          <label className="field">
            <span>Federal constituency</span>
            <select value={role === "ADMIN" ? adminForm.federalConstituencyId : role === "CANDIDATE" ? candidateForm.federalConstituencyId : agentForm.federalConstituencyId} onChange={(event) => {
              if (role === "ADMIN") { setAdminForm({ ...adminForm, federalConstituencyId: event.target.value }); }
              if (role === "CANDIDATE") { setCandidateForm({ ...candidateForm, federalConstituencyId: event.target.value }); }
              if (role === "AGENT") { setAgentForm({ ...agentForm, federalConstituencyId: event.target.value }); }
            }}>
              <option value="">Unspecified</option>
              {federalConstituencies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>

          <label className="field">
            <span>LGA</span>
            <select value={role === "ADMIN" ? adminForm.lgaId : role === "CANDIDATE" ? candidateForm.lgaId : agentForm.lgaId} onChange={async (event) => {
              const token = readSession();
              if (!token) { return; }
              const value = event.target.value;
              const currentStateId = role === "ADMIN" ? adminForm.stateId : role === "CANDIDATE" ? candidateForm.stateId : agentForm.stateId;
              await refreshLookups(token, currentStateId, value, role === "ADMIN" ? adminForm.senatorialDistrictId : role === "CANDIDATE" ? candidateForm.senatorialDistrictId : agentForm.senatorialDistrictId);
              if (role === "ADMIN") { setAdminForm({ ...adminForm, lgaId: value, wardId: "", stateConstituencyId: "" }); }
              if (role === "CANDIDATE") { setCandidateForm({ ...candidateForm, lgaId: value, wardId: "", stateConstituencyId: "" }); }
              if (role === "AGENT") { setAgentForm({ ...agentForm, lgaId: value, wardId: "", stateConstituencyId: "", pollingUnitId: "" }); }
            }}>
              <option value="">Unspecified</option>
              {lgas.filter((item) => !user.adminProfile?.lgaId || item.id === user.adminProfile.lgaId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>

          <label className="field">
            <span>State constituency</span>
            <select value={role === "ADMIN" ? adminForm.stateConstituencyId : role === "CANDIDATE" ? candidateForm.stateConstituencyId : agentForm.stateConstituencyId} onChange={(event) => {
              if (role === "ADMIN") { setAdminForm({ ...adminForm, stateConstituencyId: event.target.value }); }
              if (role === "CANDIDATE") { setCandidateForm({ ...candidateForm, stateConstituencyId: event.target.value }); }
              if (role === "AGENT") { setAgentForm({ ...agentForm, stateConstituencyId: event.target.value }); }
            }}>
              <option value="">Unspecified</option>
              {stateConstituencies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>

          <label className="field">
            <span>Ward</span>
            <select value={role === "ADMIN" ? adminForm.wardId : role === "CANDIDATE" ? candidateForm.wardId : agentForm.wardId} onChange={async (event) => {
              const value = event.target.value;
              const token = readSession();
              const currentStateId = role === "ADMIN" ? adminForm.stateId : role === "CANDIDATE" ? candidateForm.stateId : agentForm.stateId;
              const currentLgaId = role === "ADMIN" ? adminForm.lgaId : role === "CANDIDATE" ? candidateForm.lgaId : agentForm.lgaId;
              if (token && currentStateId && currentLgaId) {
                await refreshLookups(
                  token,
                  currentStateId,
                  currentLgaId,
                  role === "ADMIN" ? adminForm.senatorialDistrictId : role === "CANDIDATE" ? candidateForm.senatorialDistrictId : agentForm.senatorialDistrictId,
                  value || undefined,
                );
              } else {
                setPollingUnits([]);
              }
              if (role === "ADMIN") { setAdminForm({ ...adminForm, wardId: value }); }
              if (role === "CANDIDATE") { setCandidateForm({ ...candidateForm, wardId: value }); }
              if (role === "AGENT") { setAgentForm({ ...agentForm, wardId: value, pollingUnitId: "" }); }
            }}>
              <option value="">Unspecified</option>
              {wards.filter((item) => !user.adminProfile?.wardId || item.id === user.adminProfile.wardId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>

          {role === "AGENT" ? (
            <label className="field">
              <span>Polling unit</span>
              <select
                value={agentForm.pollingUnitId}
                onChange={(event) => setAgentForm({ ...agentForm, pollingUnitId: event.target.value })}
              >
                <option value="">Select polling unit</option>
                {pollingUnits.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          ) : null}

          <div className="action-row">
            <button className="button" type="button" disabled={saving} onClick={() => void handleSave()}>
              {saving ? "Saving..." : mode === "create" ? `Create ${role}` : `Save ${role}`}
            </button>
            <Link className="button secondary" href="/admin/manage/users">Back to user list</Link>
          </div>
          {role === "AGENT" && agentForm.wardId && pollingUnits.length === 0 ? (
            <p className="muted">No polling units are loaded for this ward yet. Load or sync polling units before creating agents in this territory.</p>
          ) : null}
          {role === "AGENT" ? (
            <p className="muted">Each agent is assigned to a single polling unit and is linked automatically to the admin responsible for that territory.</p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
