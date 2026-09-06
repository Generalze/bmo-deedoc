"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { CandidatePublicProfile } from "@pics-nigeria/shared";
import { ApiError, fetchPublicCandidateProfile } from "../../../lib/api";
import { DetailList, Kpi, KpiRow, PageHead, Panel, PanelGrid, StateView, formatCount } from "../../../components/ui";

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
  params: Promise<{ candidateUserId: string }>;
};

function renderMaterialPreview(material: CandidatePublicProfile["materials"][number]) {
  if (material.mediaType === "IMAGE" && material.mediaUrl) {
    return <img src={material.thumbnailUrl || material.mediaUrl} alt={material.title} className="campaign-material-preview" />;
  }

  if (material.mediaType === "VIDEO" && material.mediaUrl) {
    return (
      <video className="campaign-material-preview" controls preload="metadata">
        <source src={material.mediaUrl} />
      </video>
    );
  }

  return <div className="campaign-material-preview fallback">{material.mediaType}</div>;
}

function splitProfileNarrative(candidate: CandidatePublicProfile) {
  const blocks = (candidate.bio || "")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return {
      campaignMessage: candidate.campaignSlogan || "No campaign summary has been published yet.",
      highlights: [] as string[],
    };
  }

  return {
    campaignMessage: blocks[0],
    highlights: blocks.slice(1, 4),
  };
}

export default function CandidateDetailPage({ params }: Props) {
  const [candidate, setCandidate] = useState<CandidatePublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    params
      .then(async ({ candidateUserId: resolvedId }) => {
        const nextCandidate = await fetchPublicCandidateProfile(resolvedId);
        setCandidate(nextCandidate);
      })
      .catch((caughtError) => {
        setError(caughtError instanceof ApiError ? caughtError.message : "Could not load candidate profile.");
      })
      .finally(() => setLoading(false));
  }, [params]);

  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Candidate profile" />
        <StateView kind="loading" title="Loading candidate profile…" />
      </main>
    );
  }

  if (error || !candidate) {
    return (
      <main className="console-shell">
        <PageHead title="Candidate profile" />
        <StateView
          kind="empty"
          title="Candidate profile unavailable"
          detail={error || "This candidate profile is not currently published."}
          action={
            <Link className="btn btn-primary" href="/candidates">
              Back to the candidate directory
            </Link>
          }
        />
      </main>
    );
  }

  const narrative = splitProfileNarrative(candidate);
  const materialBreakdown = useMemo(() => {
    return candidate.materials.reduce<Record<string, number>>((accumulator, material) => {
      accumulator[material.mediaType] = (accumulator[material.mediaType] || 0) + 1;
      return accumulator;
    }, {});
  }, [candidate.materials]);

  const territoryLine = [
    candidate.territoryLabels.state || "National",
    candidate.territoryLabels.senatorialDistrict,
    candidate.territoryLabels.federalConstituency,
    candidate.territoryLabels.stateConstituency,
    candidate.territoryLabels.lga,
    candidate.territoryLabels.ward,
    candidate.territoryLabels.pollingUnit,
  ].filter(Boolean).join(" | ");

  return (
    <main className="console-shell">
      <PageHead
        title={candidate.name}
        lead={`${officeLabels[candidate.officeType] || candidate.officeType} · ${
          candidate.party?.name || "Independent / party not listed"
        }`}
        actions={
          <>
            <Link className="btn" href={`/candidates?officeType=${encodeURIComponent(candidate.officeType)}`}>
              More {officeLabels[candidate.officeType] || candidate.officeType}
            </Link>
            {candidate.party ? (
              <Link className="btn" href={`/parties/${candidate.party.id}`}>
                Party profile
              </Link>
            ) : null}
          </>
        }
      />

      <div className="stack-4">
        <Panel>
          <div className="candidate-identity">
            {candidate.portraitUrl ? (
              <img src={candidate.portraitUrl} alt={`${candidate.name} portrait`} className="candidate-portrait" />
            ) : (
              <div className="candidate-portrait fallback">{candidate.name.slice(0, 1)}</div>
            )}
            <div className="stack-2">
              <p>{candidate.campaignSlogan || "Campaign slogan not provided."}</p>
              <p className="cluster">
                <span className="pill pill-executed">published profile</span>
                {candidate.party?.isApprovedByInec ? <span className="pill pill-executed">INEC listed party</span> : null}
                <span className="muted-text">{candidate.territoryLabels.state || "Ogun State"}</span>
              </p>
              {candidate.territory.stateId ? (
                <Link className="btn btn-sm" href={`/candidates?stateId=${encodeURIComponent(candidate.territory.stateId)}`}>
                  More candidates in {candidate.territoryLabels.state || "this state"}
                </Link>
              ) : null}
            </div>
          </div>
        </Panel>

        <KpiRow>
          <Kpi label="Published materials" value={formatCount(candidate.materials.length)} />
          <Kpi label="Upcoming events" value={formatCount(candidate.upcomingEvents.length)} />
          <Kpi label="Office" value={officeLabels[candidate.officeType] || candidate.officeType} />
          <Kpi label="Territory scope" value={candidate.territoryLabels.state || "Ogun State"} />
        </KpiRow>

        <PanelGrid>
          <Panel title="Campaign message">
            <div className="stack-3">
              <p>{narrative.campaignMessage}</p>
              {candidate.campaignSlogan && candidate.campaignSlogan !== narrative.campaignMessage ? (
                <p className="muted-text">Campaign slogan: {candidate.campaignSlogan}</p>
              ) : null}
              {candidate.party ? (
                <p className="muted-text">
                  Party: <Link href={`/parties/${candidate.party.id}`}>{candidate.party.name}</Link>
                </p>
              ) : null}
              <div className="btn-row">
                {candidate.websiteUrl ? (
                  <a className="btn btn-sm" href={candidate.websiteUrl} target="_blank" rel="noreferrer">
                    Website
                  </a>
                ) : null}
                {candidate.facebookUrl ? (
                  <a className="btn btn-sm" href={candidate.facebookUrl} target="_blank" rel="noreferrer">
                    Facebook
                  </a>
                ) : null}
                {candidate.instagramUrl ? (
                  <a className="btn btn-sm" href={candidate.instagramUrl} target="_blank" rel="noreferrer">
                    Instagram
                  </a>
                ) : null}
                {candidate.xUrl ? (
                  <a className="btn btn-sm" href={candidate.xUrl} target="_blank" rel="noreferrer">
                    X
                  </a>
                ) : null}
              </div>
            </div>
          </Panel>

          <Panel title="Territory and office scope">
            <div className="stack-3">
              <p className="muted-text">{territoryLine}</p>
              <DetailList
                rows={[
                  { label: "State", value: candidate.territoryLabels.state || "Ogun State" },
                  candidate.territoryLabels.lga ? { label: "LGA", value: candidate.territoryLabels.lga } : null,
                  candidate.territoryLabels.ward ? { label: "Ward", value: candidate.territoryLabels.ward } : null,
                  candidate.territoryLabels.senatorialDistrict
                    ? { label: "Senatorial district", value: candidate.territoryLabels.senatorialDistrict }
                    : null,
                  candidate.territoryLabels.federalConstituency
                    ? { label: "Federal constituency", value: candidate.territoryLabels.federalConstituency }
                    : null,
                  candidate.territoryLabels.stateConstituency
                    ? { label: "State constituency", value: candidate.territoryLabels.stateConstituency }
                    : null,
                ]}
              />
            </div>
          </Panel>
        </PanelGrid>

        <Panel title="Manifesto highlights" meta="Published by this campaign">
          {narrative.highlights.length === 0 ? (
            <StateView kind="empty" title="No structured highlights have been published yet" />
          ) : (
            <ol className="stack-2" style={{ paddingLeft: "1.25rem", margin: 0 }}>
              {narrative.highlights.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel
          title="Campaign materials"
          meta={`${formatCount(candidate.materials.length)} published`}
          actions={
            <Link className="btn btn-sm" href="/candidates">
              Browse other candidates
            </Link>
          }
        >
          {candidate.materials.length === 0 ? (
            <StateView
              kind="empty"
              title="No published campaign materials yet"
              detail="Return later to see speeches, flyers, videos and manifesto updates."
            />
          ) : (
            <div className="stack-3">
              <div className="cluster">
                {Object.entries(materialBreakdown).map(([mediaType, count]) => (
                  <span key={mediaType} className="pill pill-stale">
                    {mediaType.toLowerCase()}: {count}
                  </span>
                ))}
              </div>
              <div className="candidate-material-gallery">
                {candidate.materials.map((material) => (
                  <article key={material.id} className="candidate-material-card">
                    {renderMaterialPreview(material)}
                    <div className="candidate-material-copy">
                      <p className="kpi-label">{material.mediaType}</p>
                      <h3>{material.title}</h3>
                      <p>{material.content}</p>
                      {material.mediaUrl ? (
                        <a className="btn btn-sm" href={material.mediaUrl} target="_blank" rel="noreferrer">
                          Open media
                        </a>
                      ) : null}
                      <p className="muted-text">{new Date(material.createdAt).toLocaleString()}</p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel title="Upcoming campaign events" meta={`${formatCount(candidate.upcomingEvents.length)} published`}>
          {candidate.upcomingEvents.length === 0 ? (
            <StateView
              kind="empty"
              title="No published events yet"
              detail="Return later for campaign dates, venues and mobilisation updates."
            />
          ) : (
            <div className="campaign-event-grid">
              {candidate.upcomingEvents.map((event) => (
                <article key={event.id} className="campaign-event-card">
                  {event.coverImageUrl ? (
                    <img src={event.coverImageUrl} alt={event.title} className="campaign-event-cover" />
                  ) : (
                    <div className="campaign-event-cover fallback">Event</div>
                  )}
                  <div className="campaign-event-copy">
                    <p className="kpi-label">{event.territoryLabels.state || "Ogun State"}</p>
                    <h3>{event.title}</h3>
                    <p>{event.description}</p>
                    <p className="muted-text">
                      {new Date(event.startsAt).toLocaleString()} · {event.venue}
                    </p>
                    <p className="muted-text">
                      {[event.territoryLabels.state || "Ogun State", event.territoryLabels.lga, event.territoryLabels.ward]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <Link className="btn btn-sm" href="/login">
                      Sign in to RSVP
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
