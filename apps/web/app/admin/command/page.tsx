"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  LEADERBOARD_METRICS,
  LEADERBOARD_METRIC_LABELS,
  STRENGTH_BAND_THRESHOLDS,
  type DashboardLevel,
  type HierarchicalDashboard,
  type LeaderboardMetric,
  type StrengthBand,
} from "@pics-nigeria/shared";
import { AdminNav } from "../../../components/admin-nav";
import { FeedbackBanner } from "../../../components/feedback-banner";
import { ApiError, fetchHierarchicalDashboard } from "../../../lib/api";
import { readSession } from "../../../lib/session";


function bandColor(band: StrengthBand) {
  return STRENGTH_BAND_THRESHOLDS.find((entry) => entry.band === band)?.color || "#64748b";
}

function bandLabel(band: StrengthBand) {
  return STRENGTH_BAND_THRESHOLDS.find((entry) => entry.band === band)?.label || band;
}

function trendGlyph(trend: HierarchicalDashboard["trend"]) {
  if (trend === "IMPROVING") return "▲ improving";
  if (trend === "DECLINING") return "▼ declining";
  if (trend === "STABLE") return "■ stable";
  return "— no prior snapshot";
}

export default function CommandDashboardPage() {
  const [dashboard, setDashboard] = useState<HierarchicalDashboard | null>(null);
  const [scope, setScope] = useState<{ level?: DashboardLevel; territoryId?: string }>({});
  const [metric, setMetric] = useState<LeaderboardMetric>("VERIFIED_REFERRALS");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const token = readSession();
    if (!token) {
      // Redirect rather than render: returning here left the entire admin
      // navigation on screen for an anonymous visitor, which every other admin
      // page avoids by leaving.
      window.location.href = "/login";
      return;
    }

    setLoading(true);
    try {
      const result = await fetchHierarchicalDashboard(token, {
        level: scope.level,
        territoryId: scope.territoryId,
        leaderboardMetric: metric,
      });
      setDashboard(result);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The command dashboard could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [scope.level, scope.territoryId, metric]);

  useEffect(() => {
    void load();
  }, [load]);

  const accent = dashboard?.presentation.accent || "#334155";

  return (
    <div className="admin-shell">
      <AdminNav />
      <main className="admin-main">
        {error ? <FeedbackBanner tone="error" message={error} /> : null}

        {dashboard ? (
          <>
            {/* The header is level-styled so a Ward view is never mistaken for a
                Federal Constituency view at a glance. */}
            <header className="command-header" style={{ borderColor: accent }}>
              <nav className="command-breadcrumb" aria-label="Command hierarchy">
                {dashboard.breadcrumb.map((crumb, index) => (
                  <span key={`${crumb.level}-${crumb.territoryId}`}>
                    {index > 0 ? <span aria-hidden="true"> / </span> : null}
                    <button
                      type="button"
                      className="command-crumb"
                      onClick={() => setScope({ level: crumb.level, territoryId: crumb.territoryId })}
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </nav>

              <p className="command-eyebrow" style={{ color: accent }}>
                {dashboard.presentation.singular}
              </p>
              <h1 className="command-title">{dashboard.territoryName}</h1>
              <p className="command-summary">{dashboard.presentation.summary}</p>

              <div className="command-strength">
                <div className="command-score" style={{ background: bandColor(dashboard.band) }}>
                  <span className="command-score-value">{dashboard.strengthScore}</span>
                  <span className="command-score-unit">/ 100</span>
                </div>
                <div>
                  <p className="command-band" style={{ color: bandColor(dashboard.band) }}>
                    {bandLabel(dashboard.band)}
                  </p>
                  <p className="command-trend">{trendGlyph(dashboard.trend)}</p>
                </div>
              </div>
            </header>

            {dashboard.referenceDataIncomplete ? (
              <FeedbackBanner
                tone="info"
                message={`No ${dashboard.presentation.childUnitPlural} are loaded for this ${dashboard.presentation.singular}. This is missing authoritative Ogun reference data, not an empty hierarchy.`}
              />
            ) : null}

            <section className="command-tiles" aria-label="Metrics">
              {dashboard.tiles.map((tile) => (
                <article key={tile.key} className="command-tile">
                  <p className="command-tile-label">{tile.label}</p>
                  <p className="command-tile-value">{tile.value.toLocaleString()}</p>
                  {tile.target !== null ? (
                    <p className="command-tile-target">
                      {tile.percentageOfTarget}% of {tile.target.toLocaleString()}
                      {tile.shortfall ? ` · ${tile.shortfall.toLocaleString()} short` : " · target met"}
                    </p>
                  ) : (
                    <p className="command-tile-target command-tile-muted">No target set</p>
                  )}
                </article>
              ))}
            </section>

            {dashboard.childLevel ? (
              <section className="command-section" aria-label="Heatmap">
                <div className="command-section-head">
                  <h2>{dashboard.presentation.childUnitPlural} heatmap</h2>
                  <ul className="command-legend">
                    {STRENGTH_BAND_THRESHOLDS.map((entry) => (
                      <li key={entry.band}>
                        <span className="command-swatch" style={{ background: entry.color }} aria-hidden="true" />
                        {entry.label} ({entry.minimumScore}+)
                      </li>
                    ))}
                  </ul>
                </div>

                {dashboard.children.length === 0 ? (
                  <p className="command-empty">No {dashboard.presentation.childUnitPlural.toLowerCase()} to display.</p>
                ) : (
                  <>
                    <div className="command-heatmap">
                      {dashboard.children.map((child) => (
                        <button
                          key={child.territoryId}
                          type="button"
                          className="command-heat-cell"
                          style={{ background: bandColor(child.band) }}
                          onClick={() => setScope({ level: child.level, territoryId: child.territoryId })}
                          title={`${child.name} — ${child.strengthScore}/100 (${bandLabel(child.band)})`}
                        >
                          <span className="command-heat-name">{child.name}</span>
                          <span className="command-heat-score">{child.strengthScore}</span>
                        </button>
                      ))}
                    </div>

                    <div className="command-table-wrap">
                      <table className="command-table">
                        <thead>
                          <tr>
                            <th>{dashboard.presentation.childUnitPlural.replace(/s$/, "")}</th>
                            <th>Strength</th>
                            <th>Registered</th>
                            <th>Verified</th>
                            <th>Coordinators</th>
                            <th>Polling Units</th>
                            <th>Trend</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {dashboard.children.map((child) => (
                            <tr key={child.territoryId}>
                              <td>{child.name}</td>
                              <td>
                                <span className="command-pill" style={{ background: bandColor(child.band) }}>
                                  {child.strengthScore} · {bandLabel(child.band)}
                                </span>
                              </td>
                              <td>{child.registeredMembers.toLocaleString()}</td>
                              <td>{child.verifiedMembers.toLocaleString()}</td>
                              <td>{child.coordinators.toLocaleString()}</td>
                              <td>{child.pollingUnits.toLocaleString()}</td>
                              <td>{trendGlyph(child.trend)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="command-drill"
                                  onClick={() => setScope({ level: child.level, territoryId: child.territoryId })}
                                >
                                  Drill in
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </section>
            ) : null}

            {dashboard.pollingUnitDetail ? (
              <section className="command-section" aria-label="Polling Unit detail">
                <h2>Polling Unit readiness</h2>
                <dl className="command-detail">
                  <div>
                    <dt>Operational status</dt>
                    <dd>{dashboard.pollingUnitDetail.operationalStatus.replace(/_/g, " ")}</dd>
                  </div>
                  <div>
                    <dt>Checked in</dt>
                    <dd>
                      {dashboard.pollingUnitDetail.checkedInAt
                        ? new Date(dashboard.pollingUnitDetail.checkedInAt).toLocaleString()
                        : "Not checked in"}
                    </dd>
                  </div>
                  <div>
                    <dt>Coordinator</dt>
                    <dd>{dashboard.pollingUnitDetail.coordinatorName || "Unassigned"}</dd>
                  </div>
                  <div>
                    <dt>Incidents</dt>
                    <dd>{dashboard.pollingUnitDetail.incidentCount}</dd>
                  </div>
                  <div>
                    <dt>Reports</dt>
                    <dd>{dashboard.pollingUnitDetail.reportCount}</dd>
                  </div>
                  <div>
                    <dt>Evidence</dt>
                    <dd>{dashboard.pollingUnitDetail.evidenceCount}</dd>
                  </div>
                </dl>
              </section>
            ) : null}

            <section className="command-section" aria-label="Leaderboard">
              <div className="command-section-head">
                <h2>Coordinator performance</h2>
                <label className="command-metric-select">
                  Rank by
                  <select value={metric} onChange={(event) => setMetric(event.target.value as LeaderboardMetric)}>
                    {LEADERBOARD_METRICS.map((option) => (
                      <option key={option} value={option}>
                        {LEADERBOARD_METRIC_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="command-note">
                Ranked on approved operational metrics only. Coordinators are never ranked on political preference.
              </p>

              {dashboard.leaderboard.length === 0 ? (
                <p className="command-empty">No coordinators are assigned in this scope yet.</p>
              ) : (
                <ol className="command-leaderboard">
                  {dashboard.leaderboard.map((entry) => (
                    <li key={entry.coordinatorUserId}>
                      <span className="command-rank">{entry.rank}</span>
                      <span className="command-leader-name">{entry.name}</span>
                      <span className="command-leader-level">{entry.coordinatorLevel?.replace(/_/g, " ") || "—"}</span>
                      <span className="command-leader-value">
                        {entry.value.toLocaleString()} {LEADERBOARD_METRIC_LABELS[entry.metric].toLowerCase()}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <p className="command-generated">
              Generated {new Date(dashboard.generatedAt).toLocaleString()} ·{" "}
              <Link href="/election-day/situation-room">Election Day Situation Room</Link>
            </p>
          </>
        ) : (
          <p className="command-empty">{loading ? "Loading command dashboard…" : "No dashboard available."}</p>
        )}
      </main>
    </div>
  );
}
