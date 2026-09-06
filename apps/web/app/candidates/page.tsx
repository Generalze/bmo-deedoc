"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CANDIDATE_OFFICE_TYPES, type CandidateOfficeType, type CandidatePublicListItem, type PoliticalPartyItem, type StateItem } from "@pics-nigeria/shared";
import { ApiError, fetchPublicCandidates, fetchPublicParties, fetchPublicStates } from "../../lib/api";
import {
  Kpi,
  KpiRow,
  Notice,
  PageHead,
  Panel,
  StateView,
  Toolbar,
  ToolbarEnd,
  ToolbarField,
  formatCount,
} from "../../components/ui";

const officeLabels: Record<string, string> = {
  PRESIDENTIAL: "Presidential",
  GOVERNORSHIP: "Governorship",
  SENATE: "Senate",
  HOUSE_OF_REP: "House of Representatives",
  STATE_ASSEMBLY: "State Assembly",
  CHAIRMANSHIP: "Chairmanship",
  COUNCILLOR: "Councillor",
};

export default function CandidatesPage() {
  const [states, setStates] = useState<StateItem[]>([]);
  const [parties, setParties] = useState<PoliticalPartyItem[]>([]);
  const [candidates, setCandidates] = useState<CandidatePublicListItem[]>([]);
  const [search, setSearch] = useState("");
  const [stateId, setStateId] = useState("");
  const [partyId, setPartyId] = useState("");
  const [officeType, setOfficeType] = useState<CandidateOfficeType | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const officeBreakdown = useMemo(() => {
    return candidates.reduce<Record<string, number>>((accumulator, candidate) => {
      accumulator[candidate.officeType] = (accumulator[candidate.officeType] || 0) + 1;
      return accumulator;
    }, {});
  }, [candidates]);

  const approvedPartyCount = useMemo(() => {
    return new Set(
      candidates
        .filter((candidate) => candidate.party?.isApprovedByInec)
        .map((candidate) => candidate.party!.id),
    ).size;
  }, [candidates]);

  const visibleStateCount = useMemo(() => {
    return new Set(candidates.map((candidate) => candidate.territory.stateId).filter(Boolean)).size;
  }, [candidates]);

  const selectedStateName = useMemo(
    () => states.find((item) => item.id === stateId)?.name || "",
    [stateId, states],
  );

  const selectedPartyName = useMemo(() => {
    if (partyId === "independent") {
      return "Independent";
    }

    return parties.find((item) => item.id === partyId)?.name || "";
  }, [parties, partyId]);

  async function loadDirectory(nextSearch = search, nextStateId = stateId, nextPartyId = partyId, nextOfficeType = officeType) {
    setError("");
    const [nextStates, nextParties, nextCandidates] = await Promise.all([
      fetchPublicStates(),
      fetchPublicParties(),
      fetchPublicCandidates({
        search: nextSearch || undefined,
        stateId: nextStateId || undefined,
        partyId: nextPartyId || undefined,
        officeType: nextOfficeType || undefined,
      }),
    ]);

    setStates(nextStates);
    setParties(nextParties);
    setCandidates(nextCandidates);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextSearch = params.get("search") || "";
    const nextStateId = params.get("stateId") || "";
    const nextPartyId = params.get("partyId") || "";
    const nextOfficeType = (params.get("officeType") as CandidateOfficeType | "") || "";

    setSearch(nextSearch);
    setStateId(nextStateId);
    setPartyId(nextPartyId);
    setOfficeType(nextOfficeType);

    loadDirectory(nextSearch, nextStateId, nextPartyId, nextOfficeType)
      .catch((caughtError) => {
        setError(caughtError instanceof ApiError ? caughtError.message : "Could not load candidate directory.");
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleApplyFilters() {
    setLoading(true);
    try {
      await loadDirectory(search, stateId, partyId, officeType);
      const params = new URLSearchParams();
      if (search) {
        params.set("search", search);
      }
      if (stateId) {
        params.set("stateId", stateId);
      }
      if (partyId) {
        params.set("partyId", partyId);
      }
      if (officeType) {
        params.set("officeType", officeType);
      }
      const suffix = params.toString();
      window.history.replaceState({}, "", suffix ? `/candidates?${suffix}` : "/candidates");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not apply candidate filters.");
    } finally {
      setLoading(false);
    }
  }

  function handleClearFilters() {
    setSearch("");
    setStateId("");
    setPartyId("");
    setOfficeType("");
    setLoading(true);

    loadDirectory("", "", "", "")
      .then(() => window.history.replaceState({}, "", "/candidates"))
      .catch((caughtError) => setError(caughtError instanceof Error ? caughtError.message : "Could not reset candidate filters."))
      .finally(() => setLoading(false));
  }

  return (
    <main className="console-shell">
      <PageHead
        title="Candidate directory"
        lead="Search published candidate profiles, compare offices, and browse campaign materials by territory and party."
        actions={
          <Link className="btn" href="/parties">
            Party portfolio
          </Link>
        }
      />

      <div className="stack-4">
        {error ? <Notice tone="error" title="Could not load the directory">{error}</Notice> : null}

        <Panel title="Find a candidate" flush>
          <Toolbar>
            <ToolbarField label="Search by name" hideLabel>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search candidates"
              />
            </ToolbarField>
            <ToolbarField label="State">
              <select value={stateId} onChange={(event) => setStateId(event.target.value)}>
                <option value="">All states</option>
                {states.map((state) => (
                  <option key={state.id} value={state.id}>
                    {state.name}
                  </option>
                ))}
              </select>
            </ToolbarField>
            <ToolbarField label="Party">
              <select value={partyId} onChange={(event) => setPartyId(event.target.value)}>
                <option value="">All parties</option>
                <option value="independent">Independent</option>
                {parties.map((party) => (
                  <option key={party.id} value={party.id}>
                    {party.code} — {party.name}
                  </option>
                ))}
              </select>
            </ToolbarField>
            <ToolbarField label="Office">
              <select
                value={officeType}
                onChange={(event) => setOfficeType(event.target.value as CandidateOfficeType | "")}
              >
                <option value="">All offices</option>
                {CANDIDATE_OFFICE_TYPES.map((office) => (
                  <option key={office} value={office}>
                    {officeLabels[office]}
                  </option>
                ))}
              </select>
            </ToolbarField>
            <ToolbarEnd>
              <button className="btn btn-sm btn-primary" type="button" onClick={() => void handleApplyFilters()} disabled={loading}>
                {loading ? "Loading…" : "Apply"}
              </button>
              <button className="btn btn-sm" type="button" onClick={() => handleClearFilters()} disabled={loading}>
                Clear
              </button>
            </ToolbarEnd>
          </Toolbar>

          {search || stateId || partyId || officeType ? (
            <div className="panel-body cluster">
              {search ? <span className="pill pill-pending">Search: {search}</span> : null}
              {selectedStateName ? <span className="pill pill-pending">State: {selectedStateName}</span> : null}
              {selectedPartyName ? <span className="pill pill-pending">Party: {selectedPartyName}</span> : null}
              {officeType ? <span className="pill pill-pending">Office: {officeLabels[officeType]}</span> : null}
            </div>
          ) : null}
        </Panel>

        {!loading ? (
          <KpiRow>
            <Kpi label="Visible candidates" value={formatCount(candidates.length)} note="Matching your filters" />
            <Kpi label="States in result" value={formatCount(visibleStateCount)} />
            <Kpi label="INEC-listed parties" value={formatCount(approvedPartyCount)} />
          </KpiRow>
        ) : null}

        {!loading && candidates.length > 0 ? (
          <Panel title="Office coverage" meta="Select one to filter">
            <div className="cluster">
              {Object.entries(officeBreakdown).map(([office, count]) => (
                <button
                  key={office}
                  className={officeType === office ? "btn btn-sm btn-primary" : "btn btn-sm"}
                  type="button"
                  aria-pressed={officeType === office}
                  onClick={() => {
                    setOfficeType(office as CandidateOfficeType);
                    void loadDirectory(search, stateId, partyId, office as CandidateOfficeType);
                  }}
                >
                  {officeLabels[office] || office} ({count})
                </button>
              ))}
            </div>
          </Panel>
        ) : null}

        {loading ? (
          <StateView kind="loading" title="Loading candidate directory…" />
        ) : candidates.length === 0 ? (
          <StateView
            kind="empty"
            title="No published candidates found"
            detail="Try widening your filters, or return when more campaign profiles are published."
          />
        ) : (
          /* A directory of people, each with a portrait. Cards are the right
             shape for choosing between them. */
          <div className="candidate-grid">
            {candidates.map((candidate) => (
              <article key={candidate.userId} className="candidate-card">
                {candidate.portraitUrl ? (
                  <img src={candidate.portraitUrl} alt={`${candidate.name} portrait`} className="candidate-card-media" />
                ) : (
                  <div className="candidate-card-media fallback">{candidate.name.slice(0, 1)}</div>
                )}
                <div className="candidate-card-body">
                  <p className="kpi-label">{officeLabels[candidate.officeType] || candidate.officeType}</p>
                  <h2>{candidate.name}</h2>
                  <p className="muted-text">{candidate.party?.name || "Independent / party not listed"}</p>
                  <p>{candidate.campaignSlogan || candidate.bio || "Campaign profile coming soon."}</p>
                  <p className="muted-text">
                    {[
                      candidate.territoryLabels.state || "Ogun State",
                      candidate.territoryLabels.senatorialDistrict,
                      candidate.territoryLabels.federalConstituency,
                      candidate.territoryLabels.stateConstituency,
                      candidate.territoryLabels.lga,
                      candidate.territoryLabels.ward,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="cluster">
                    {candidate.party?.code ? <span className="pill pill-stale">{candidate.party.code}</span> : null}
                    {candidate.party?.isApprovedByInec ? <span className="pill pill-executed">INEC listed</span> : null}
                  </p>
                  <div className="btn-row">
                    <Link className="btn btn-sm" href={`/candidates/${candidate.userId}`}>
                      View profile
                    </Link>
                    {candidate.party ? (
                      <Link className="btn btn-sm" href={`/parties/${candidate.party.id}`}>
                        View party
                      </Link>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
