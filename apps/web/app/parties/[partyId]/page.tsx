"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PoliticalPartyPublicProfile } from "@pics-nigeria/shared";
import { ApiError, fetchPublicPartyProfile } from "../../../lib/api";
import { DetailList, PageHead, Panel, PanelGrid, StateView, formatCount } from "../../../components/ui";

const officeLabels: Record<string, string> = {
  PRESIDENTIAL: "Presidential",
  GOVERNORSHIP: "Governorship",
  SENATE: "Senate",
  HOUSE_OF_REP: "House of Representatives",
  STATE_ASSEMBLY: "State Assembly",
  CHAIRMANSHIP: "Chairmanship",
  COUNCILLOR: "Councillor",
};

type Props = {
  params: Promise<{ partyId: string }>;
};

export default function PartyDetailPage({ params }: Props) {
  const [party, setParty] = useState<PoliticalPartyPublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    params
      .then(async ({ partyId }) => {
        setParty(await fetchPublicPartyProfile(partyId));
      })
      .catch((caughtError) => {
        setError(caughtError instanceof ApiError ? caughtError.message : "Could not load political party profile.");
      })
      .finally(() => setLoading(false));
  }, [params]);

  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Political party" />
        <StateView kind="loading" title="Loading party profile…" />
      </main>
    );
  }

  if (error || !party) {
    return (
      <main className="console-shell">
        <PageHead title="Political party" />
        <StateView
          kind="empty"
          title="Political party unavailable"
          detail={error || "This party profile is not available right now."}
          action={
            <Link className="btn btn-primary" href="/parties">
              Back to the party directory
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <main className="console-shell">
      <PageHead
        title={party.name}
        lead={party.description || `${party.name} is listed for candidate discovery and public campaign browsing.`}
        actions={
          <Link className="btn" href="/parties">
            All parties
          </Link>
        }
      />

      <div className="stack-4">
        <div className="cluster">
          <span className="pill pill-stale">{party.code}</span>
          {party.isApprovedByInec ? (
            <span className="pill pill-executed">INEC listed</span>
          ) : (
            <span className="pill pill-stale">custom party record</span>
          )}
          <span className="muted-text">{formatCount(party.candidates.length)} published candidates</span>
        </div>

        <PanelGrid>
          <Panel title="Party profile">
            <DetailList
              rows={[
                { label: "Party code", value: party.code },
                party.officialWebsite
                  ? {
                      label: "Official website",
                      value: (
                        <a href={party.officialWebsite} target="_blank" rel="noreferrer">
                          {party.officialWebsite}
                        </a>
                      ),
                    }
                  : null,
                party.inecSourceUrl
                  ? {
                      label: "INEC source",
                      value: (
                        <a href={party.inecSourceUrl} target="_blank" rel="noreferrer">
                          Open official listing
                        </a>
                      ),
                    }
                  : null,
              ]}
            />
          </Panel>

          <Panel
            title="Candidate discovery"
            actions={
              <Link className="btn btn-sm btn-primary" href={`/candidates?partyId=${party.id}`}>
                Open in directory
              </Link>
            }
          >
            <p className="muted-text">Browse only candidates with published public profiles under this party.</p>
          </Panel>
        </PanelGrid>

        <Panel
          title="Published candidates"
          meta={`${formatCount(party.candidates.length)} visible to voters`}
        >
          {party.candidates.length === 0 ? (
            <StateView
              kind="empty"
              title="No published candidates yet"
              detail="Return later, when candidates from this party publish their public profiles."
            />
          ) : (
            <div className="candidate-grid">
              {party.candidates.map((candidate) => (
                <article key={candidate.userId} className="candidate-card">
                  {candidate.portraitUrl ? (
                    <img src={candidate.portraitUrl} alt={`${candidate.name} portrait`} className="candidate-card-media" />
                  ) : (
                    <div className="candidate-card-media fallback">{candidate.name.slice(0, 1)}</div>
                  )}
                  <div className="candidate-card-body">
                    <p className="kpi-label">{officeLabels[candidate.officeType] || candidate.officeType}</p>
                    <h2>{candidate.name}</h2>
                    <p>{candidate.campaignSlogan || candidate.bio || "Campaign profile coming soon."}</p>
                    <p className="muted-text">{candidate.territoryLabels.state || "Ogun State"}</p>
                    <Link className="btn btn-sm" href={`/candidates/${candidate.userId}`}>
                      View candidate profile
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </main>
  );
}
