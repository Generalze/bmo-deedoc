"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PoliticalPartyItem } from "@pics-nigeria/shared";
import { ApiError, fetchPublicParties } from "../../lib/api";
import { Notice, PageHead, Panel, StateView, Toolbar, ToolbarEnd, ToolbarField, formatCount } from "../../components/ui";

export default function PartiesPage() {
  const [parties, setParties] = useState<PoliticalPartyItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadParties(nextSearch = search) {
    setError("");
    const nextParties = await fetchPublicParties({ search: nextSearch || undefined });
    setParties(nextParties);
  }

  useEffect(() => {
    loadParties()
      .catch((caughtError) => {
        setError(caughtError instanceof ApiError ? caughtError.message : "Could not load political parties.");
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSearch() {
    setLoading(true);
    try {
      await loadParties(search);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not filter political parties.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="console-shell">
      <PageHead
        title="Political parties"
        lead="Browse INEC-listed parties, open their portfolios, and explore published candidates under each party."
        actions={
          <Link className="btn" href="/candidates">
            Candidate discovery
          </Link>
        }
      />

      <div className="stack-4">
        {error ? <Notice tone="error" title="Could not load parties">{error}</Notice> : null}

        <Panel title="Directory" meta={`${formatCount(parties.length)} parties`} flush>
          <Toolbar>
            <ToolbarField label="Search by party name or code" hideLabel>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by party name or code"
              />
            </ToolbarField>
            <ToolbarEnd>
              <button className="btn btn-sm btn-primary" type="button" onClick={() => void handleSearch()} disabled={loading}>
                {loading ? "Loading…" : "Apply"}
              </button>
            </ToolbarEnd>
          </Toolbar>

          <div className="panel-body">
            {loading ? (
              <StateView kind="loading" title="Loading political parties…" />
            ) : parties.length === 0 ? (
              <StateView
                kind="empty"
                title="No parties found"
                detail="Try a wider search, or check again after the reference data refresh."
              />
            ) : (
              /* A directory you browse and choose from, with a party mark on
                 each entry. Cards are the right shape; a table is not. */
              <div className="candidate-grid">
                {parties.map((party) => (
                  <article key={party.id} className="candidate-card">
                    <div className="candidate-card-media fallback">{party.code}</div>
                    <div className="candidate-card-body">
                      <p className="kpi-label">{party.code}</p>
                      <h2>{party.name}</h2>
                      <p>
                        {party.description ||
                          `${party.name} is available in the public party directory for candidate discovery.`}
                      </p>
                      <p className="cluster">
                        <span className={party.isApprovedByInec ? "pill pill-executed" : "pill pill-stale"}>
                          {party.isApprovedByInec ? "INEC listed" : "custom record"}
                        </span>
                        <span className="muted-text">{formatCount(party.candidateCount || 0)} published candidates</span>
                      </p>
                      <Link className="btn btn-sm" href={`/parties/${party.id}`}>
                        Open party profile
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </main>
  );
}
