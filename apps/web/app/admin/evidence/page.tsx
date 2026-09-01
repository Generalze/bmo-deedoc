"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  EVIDENCE_CLASSIFICATIONS,
  EVIDENCE_REVIEW_STATUSES,
  EVIDENCE_TYPES,
  type AuthUserProfile,
  type EvidenceAggregationItem,
  type EvidenceAssetItem,
  type EvidenceClassification,
  type EvidenceDossier,
  type EvidenceManifest,
  type EvidenceReviewStatus,
  type EvidenceTimelineItem,
  type EvidenceType,
  type LegalCaseItem,
} from "@pics-nigeria/shared";
import { AdminNav } from "../../../components/admin-nav";
import { FeedbackBanner } from "../../../components/feedback-banner";
import { describeTerritory } from "../../../components/admin-management-utils";
import {
  ApiError,
  createEvidenceAccess,
  createEvidenceManifestExport,
  createLegalCase,
  fetchCurrentUser,
  fetchEvidenceAggregation,
  fetchEvidenceDossier,
  fetchEvidenceExplorer,
  fetchEvidenceTimeline,
  fetchLegalCases,
  finalizeEvidenceUpload,
  updateEvidenceReview,
  verifyEvidenceManifest,
} from "../../../lib/api";
import { readSession } from "../../../lib/session";

const reviewerRoles = new Set(["SUPER_ADMIN", "STATE_OFFICER", "VALIDATOR"]);
const groupOptions = ["POLLING_UNIT", "WARD", "STATE_CONSTITUENCY", "FEDERAL_CONSTITUENCY", "SENATORIAL_DISTRICT"] as const;

type Filters = {
  search: string;
  evidenceType: "" | EvidenceType;
  classification: "" | EvidenceClassification;
  reviewStatus: "" | EvidenceReviewStatus;
  pollingUnitId: string;
  incidentId: string;
  electionReportId: string;
  sha256: string;
  dateFrom: string;
  dateTo: string;
};

type UploadDraft = {
  evidenceType: EvidenceType;
  classification: EvidenceClassification;
  pollingUnitId: string;
  incidentId: string;
  electionReportId: string;
  capturedAt: string;
  latitude: string;
  longitude: string;
  accuracyMeters: string;
};

const initialFilters: Filters = {
  search: "",
  evidenceType: "",
  classification: "",
  reviewStatus: "",
  pollingUnitId: "",
  incidentId: "",
  electionReportId: "",
  sha256: "",
  dateFrom: "",
  dateTo: "",
};

const initialUpload: UploadDraft = {
  evidenceType: "PHOTO",
  classification: "INCIDENT",
  pollingUnitId: "",
  incidentId: "",
  electionReportId: "",
  capturedAt: "",
  latitude: "",
  longitude: "",
  accuracyMeters: "",
};

function toIsoStart(value: string) {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : undefined;
}

function toIsoEnd(value: string) {
  return value ? new Date(`${value}T23:59:59.999Z`).toISOString() : undefined;
}

function optionalNumber(value: string) {
  return value.trim() ? Number(value) : undefined;
}

function compactHash(value: string) {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
}

export default function AdminEvidencePage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [uploadDraft, setUploadDraft] = useState<UploadDraft>(initialUpload);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [evidence, setEvidence] = useState<EvidenceAssetItem[]>([]);
  const [summary, setSummary] = useState({ total: 0, returned: 0, byType: {}, byReviewStatus: {}, byClassification: {} });
  const [aggregation, setAggregation] = useState<EvidenceAggregationItem[]>([]);
  const [groupBy, setGroupBy] = useState<(typeof groupOptions)[number]>("WARD");
  const [legalCases, setLegalCases] = useState<LegalCaseItem[]>([]);
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, { status: EvidenceReviewStatus; classification: EvidenceClassification; note: string }>>({});
  const [timelinePollingUnitId, setTimelinePollingUnitId] = useState("");
  const [timeline, setTimeline] = useState<EvidenceTimelineItem[]>([]);
  const [dossier, setDossier] = useState<EvidenceDossier | null>(null);
  const [legalTitle, setLegalTitle] = useState("");
  const [legalDescription, setLegalDescription] = useState("");
  const [exportPurpose, setExportPurpose] = useState("Controlled post-election evidence review package");
  const [selectedLegalCaseId, setSelectedLegalCaseId] = useState("");
  const [lastManifest, setLastManifest] = useState<{ manifest: EvidenceManifest; manifestSha256: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "info"; message: string }>({ tone: "success", message: "" });

  const selectedEvidence = useMemo(
    () => evidence.filter((item) => selectedEvidenceIds.includes(item.id)),
    [evidence, selectedEvidenceIds],
  );

  async function loadEvidence(token: string, nextFilters = filters, nextGroupBy = groupBy) {
    const [currentUser, explorer, nextAggregation, cases] = await Promise.all([
      fetchCurrentUser(token),
      fetchEvidenceExplorer(token, {
        search: nextFilters.search || undefined,
        evidenceType: nextFilters.evidenceType || undefined,
        classification: nextFilters.classification || undefined,
        reviewStatus: nextFilters.reviewStatus || undefined,
        pollingUnitId: nextFilters.pollingUnitId || undefined,
        incidentId: nextFilters.incidentId || undefined,
        electionReportId: nextFilters.electionReportId || undefined,
        sha256: nextFilters.sha256 || undefined,
        dateFrom: toIsoStart(nextFilters.dateFrom),
        dateTo: toIsoEnd(nextFilters.dateTo),
        limit: 100,
      }),
      fetchEvidenceAggregation(token, {
        groupBy: nextGroupBy,
        evidenceType: nextFilters.evidenceType || undefined,
        classification: nextFilters.classification || undefined,
        reviewStatus: nextFilters.reviewStatus || undefined,
        dateFrom: toIsoStart(nextFilters.dateFrom),
        dateTo: toIsoEnd(nextFilters.dateTo),
      }),
      fetchLegalCases(token),
    ]);

    if (!reviewerRoles.has(currentUser.role)) {
      throw new ApiError("Evidence review requires Super Admin, State Officer, or Validator access.", 403);
    }

    setUser(currentUser);
    setEvidence(explorer.evidence);
    setSummary(explorer.summary);
    setAggregation(nextAggregation.aggregation);
    setLegalCases(cases);
    setReviewDrafts((current) => {
      const next = { ...current };
      for (const asset of explorer.evidence) {
        next[asset.id] = next[asset.id] || {
          status: asset.reviewStatus,
          classification: asset.classification,
          note: "",
        };
      }
      return next;
    });
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const urlFilters = {
      ...filters,
      pollingUnitId: params.get("pollingUnitId") || filters.pollingUnitId,
      incidentId: params.get("incidentId") || filters.incidentId,
      electionReportId: params.get("electionReportId") || filters.electionReportId,
      sha256: params.get("sha256") || filters.sha256,
    };
    setFilters(urlFilters);

    loadEvidence(token, urlFilters, groupBy)
      .catch((caughtError) =>
        setFeedback({
          tone: "error",
          message: caughtError instanceof Error ? caughtError.message : "Could not load evidence workspace.",
        }))
      .finally(() => setLoading(false));
  }, []);

  async function withToken(action: (token: string) => Promise<void>) {
    const token = readSession();
    if (!token) {
      setFeedback({ tone: "error", message: "Authentication is required." });
      return;
    }
    try {
      setBusy(true);
      await action(token);
    } catch (caughtError) {
      setFeedback({ tone: "error", message: caughtError instanceof Error ? caughtError.message : "Evidence action failed." });
    } finally {
      setBusy(false);
    }
  }

  async function handleFilter() {
    await withToken(async (token) => {
      setLoading(true);
      await loadEvidence(token, filters, groupBy);
      setFeedback({ tone: "success", message: "Evidence filters applied." });
      setLoading(false);
    });
  }

  async function handleUpload() {
    if (!selectedFile) {
      setFeedback({ tone: "error", message: "Choose an evidence file first." });
      return;
    }
    await withToken(async (token) => {
      const result = await finalizeEvidenceUpload(token, {
        evidenceType: uploadDraft.evidenceType,
        classification: uploadDraft.classification,
        file: selectedFile,
        pollingUnitId: uploadDraft.pollingUnitId || undefined,
        incidentId: uploadDraft.incidentId || undefined,
        electionReportId: uploadDraft.electionReportId || undefined,
        capturedAt: uploadDraft.capturedAt ? new Date(uploadDraft.capturedAt).toISOString() : undefined,
        latitude: optionalNumber(uploadDraft.latitude),
        longitude: optionalNumber(uploadDraft.longitude),
        accuracyMeters: optionalNumber(uploadDraft.accuracyMeters),
        metadata: { submittedFrom: "admin-evidence-workspace" },
      });
      setFeedback({ tone: "success", message: `${result.message} SHA-256: ${compactHash(result.evidence.sha256)}` });
      setSelectedFile(null);
      setUploadDraft(initialUpload);
      await loadEvidence(token, filters, groupBy);
    });
  }

  async function handleReview(assetId: string) {
    const draft = reviewDrafts[assetId];
    if (!draft) {
      return;
    }
    await withToken(async (token) => {
      const result = await updateEvidenceReview(token, assetId, draft);
      setFeedback({ tone: "success", message: result.message });
      await loadEvidence(token, filters, groupBy);
    });
  }

  async function handleAccess(assetId: string, action: "VIEW" | "DOWNLOAD") {
    await withToken(async (token) => {
      const result = await createEvidenceAccess(token, assetId, { action, expiresInSeconds: 300 });
      window.open(result.access.signedUrl, "_blank", "noopener,noreferrer");
      setFeedback({ tone: "info", message: `${action} signed access generated until ${new Date(result.access.expiresAt).toLocaleString()}. Access was audited.` });
    });
  }

  async function handleTimeline() {
    if (!timelinePollingUnitId.trim()) {
      setFeedback({ tone: "error", message: "Enter a Polling Unit ID for timeline and dossier." });
      return;
    }
    await withToken(async (token) => {
      const [nextTimeline, nextDossier] = await Promise.all([
        fetchEvidenceTimeline(token, timelinePollingUnitId.trim()),
        fetchEvidenceDossier(token, timelinePollingUnitId.trim()),
      ]);
      setTimeline(nextTimeline);
      setDossier(nextDossier);
      setFeedback({ tone: "success", message: "Polling Unit timeline and dossier loaded." });
    });
  }

  async function handleCreateLegalCase() {
    if (!legalTitle.trim()) {
      setFeedback({ tone: "error", message: "Legal-support workspace title is required." });
      return;
    }
    await withToken(async (token) => {
      const result = await createLegalCase(token, {
        title: legalTitle.trim(),
        description: legalDescription.trim() || undefined,
        pollingUnitId: selectedEvidence[0]?.territory.pollingUnitId || undefined,
        evidenceAssetIds: selectedEvidenceIds,
        note: "Associated from admin evidence workspace.",
      });
      setSelectedLegalCaseId(result.legalCase.id);
      setLegalTitle("");
      setLegalDescription("");
      await loadEvidence(token, filters, groupBy);
      setFeedback({ tone: "success", message: "Legal-support workspace created without legal conclusion." });
    });
  }

  async function handleExport() {
    if (selectedEvidenceIds.length === 0) {
      setFeedback({ tone: "error", message: "Select at least one evidence asset for export." });
      return;
    }
    await withToken(async (token) => {
      const result = await createEvidenceManifestExport(token, {
        evidenceAssetIds: selectedEvidenceIds,
        legalCaseId: selectedLegalCaseId || undefined,
        purpose: exportPurpose,
      });
      setLastManifest({ manifest: result.manifest, manifestSha256: result.evidencePackage.manifestSha256 });
      await loadEvidence(token, filters, groupBy);
      setFeedback({ tone: "success", message: `Manifest exported and audited. SHA-256: ${result.evidencePackage.manifestSha256}` });
    });
  }

  async function handleVerifyManifest() {
    if (!lastManifest) {
      setFeedback({ tone: "error", message: "Generate a manifest before verification." });
      return;
    }
    await withToken(async (token) => {
      const result = await verifyEvidenceManifest(token, lastManifest);
      setFeedback({
        tone: result.verified ? "success" : "error",
        message: result.verified
          ? `Manifest verified: ${result.computedSha256}`
          : `Manifest mismatch. Computed ${result.computedSha256}; supplied ${result.suppliedSha256}.`,
      });
    });
  }

  function toggleSelected(assetId: string) {
    setSelectedEvidenceIds((current) =>
      current.includes(assetId) ? current.filter((item) => item !== assetId) : [...current, assetId],
    );
  }

  if (loading && !user) {
    return (
      <main className="shell">
        <section className="panel hero">
          <h1>Loading evidence workspace...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load evidence</h1>
          <FeedbackBanner tone={feedback.tone} message={feedback.message || "Authentication is required."} />
          <Link href="/admin/dashboard">Return to admin overview</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Post-election source of truth</p>
        <h1>Evidence explorer and controlled export</h1>
        <p>Visible scope: {describeTerritory(user.adminProfile || user.coordinatorProfile || {
          geoPoliticalZoneId: null,
          stateId: null,
          senatorialDistrictId: null,
          federalConstituencyId: null,
          lgaId: null,
          wardId: null,
          stateConstituencyId: null,
          pollingUnitId: null,
        })}</p>
        <p className="muted">Originals remain private and immutable. Every view, download, review, case association, and export is backend-authorized and audited.</p>
      </section>

      <AdminNav role={user?.role} />
      <FeedbackBanner tone={feedback.tone} message={feedback.message} />

      <section className="grid stats">
        <article className="panel card">
          <h2>Total Evidence</h2>
          <div className="value">{summary.total}</div>
        </article>
        <article className="panel card">
          <h2>Returned</h2>
          <div className="value">{summary.returned}</div>
        </article>
        <article className="panel card">
          <h2>Selected</h2>
          <div className="value">{selectedEvidenceIds.length}</div>
        </article>
        <article className="panel card">
          <h2>Legal Workspaces</h2>
          <div className="value">{legalCases.length}</div>
        </article>
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <div className="section-head">
          <div>
            <h2>Search and Filters</h2>
            <p className="muted">Search by ID, hash, file name, incident, report, or Polling Unit. Filters are enforced again by the API.</p>
          </div>
          <button className="button" type="button" onClick={() => void handleFilter()} disabled={busy || loading}>
            {loading ? "Loading..." : "Apply filters"}
          </button>
        </div>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <label className="field">
            <span>Search</span>
            <input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="ID, file, hash, PU" />
          </label>
          <label className="field">
            <span>Evidence Type</span>
            <select value={filters.evidenceType} onChange={(event) => setFilters((current) => ({ ...current, evidenceType: event.target.value as Filters["evidenceType"] }))}>
              <option value="">All types</option>
              {EVIDENCE_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Classification</span>
            <select value={filters.classification} onChange={(event) => setFilters((current) => ({ ...current, classification: event.target.value as Filters["classification"] }))}>
              <option value="">All classifications</option>
              {EVIDENCE_CLASSIFICATIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Review Status</span>
            <select value={filters.reviewStatus} onChange={(event) => setFilters((current) => ({ ...current, reviewStatus: event.target.value as Filters["reviewStatus"] }))}>
              <option value="">All statuses</option>
              {EVIDENCE_REVIEW_STATUSES.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Polling Unit ID</span>
            <input value={filters.pollingUnitId} onChange={(event) => setFilters((current) => ({ ...current, pollingUnitId: event.target.value }))} />
          </label>
          <label className="field">
            <span>Incident ID</span>
            <input value={filters.incidentId} onChange={(event) => setFilters((current) => ({ ...current, incidentId: event.target.value }))} />
          </label>
          <label className="field">
            <span>Report ID</span>
            <input value={filters.electionReportId} onChange={(event) => setFilters((current) => ({ ...current, electionReportId: event.target.value }))} />
          </label>
          <label className="field">
            <span>SHA-256</span>
            <input value={filters.sha256} onChange={(event) => setFilters((current) => ({ ...current, sha256: event.target.value }))} />
          </label>
          <label className="field">
            <span>Date From</span>
            <input type="date" value={filters.dateFrom} onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))} />
          </label>
          <label className="field">
            <span>Date To</span>
            <input type="date" value={filters.dateTo} onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))} />
          </label>
        </div>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "minmax(0, 2fr) minmax(320px, 1fr)" }}>
        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Scoped Evidence</h2>
              <p className="muted">Select assets for legal association or controlled manifest export.</p>
            </div>
            <span className="status-pill">{evidence.length} visible</span>
          </div>
          {evidence.length === 0 ? (
            <p className="muted">No evidence matches the current scope and filters.</p>
          ) : (
            <div className="reward-list">
              {evidence.map((asset) => {
                const draft = reviewDrafts[asset.id] || { status: asset.reviewStatus, classification: asset.classification, note: "" };
                return (
                  <article key={asset.id} className="reward-item">
                    <label className="checkbox-field">
                      <input type="checkbox" checked={selectedEvidenceIds.includes(asset.id)} onChange={() => toggleSelected(asset.id)} />
                      <strong>{asset.originalFileName}</strong>
                    </label>
                    <p>{asset.evidenceType} | {asset.classification} | {asset.reviewStatus}</p>
                    <p className="muted">SHA-256: {asset.sha256}</p>
                    <p className="muted">PU: {asset.territory.pollingUnitId || "N/A"} | Incident: {asset.incidentId || "N/A"} | Report: {asset.electionReportId || "N/A"}</p>
                    <p className="muted">Server received: {new Date(asset.serverReceivedAt).toLocaleString()} | Original immutable: {asset.preservation.originalImmutable ? "YES" : "NO"}</p>
                    <div className="action-row" style={{ marginTop: 12 }}>
                      <button className="button secondary" type="button" onClick={() => void handleAccess(asset.id, "VIEW")} disabled={busy}>View Original</button>
                      <button className="button secondary" type="button" onClick={() => void handleAccess(asset.id, "DOWNLOAD")} disabled={busy}>Download Original</button>
                    </div>
                    <div className="grid" style={{ marginTop: 12, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
                      <label className="field">
                        <span>Next status</span>
                        <select value={draft.status} onChange={(event) => setReviewDrafts((current) => ({ ...current, [asset.id]: { ...draft, status: event.target.value as EvidenceReviewStatus } }))}>
                          {EVIDENCE_REVIEW_STATUSES.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </label>
                      <label className="field">
                        <span>Classification</span>
                        <select value={draft.classification} onChange={(event) => setReviewDrafts((current) => ({ ...current, [asset.id]: { ...draft, classification: event.target.value as EvidenceClassification } }))}>
                          {EVIDENCE_CLASSIFICATIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </label>
                    </div>
                    <label className="field" style={{ marginTop: 12 }}>
                      <span>Review note</span>
                      <textarea rows={2} value={draft.note} onChange={(event) => setReviewDrafts((current) => ({ ...current, [asset.id]: { ...draft, note: event.target.value } }))} />
                    </label>
                    <button className="button" type="button" onClick={() => void handleReview(asset.id)} disabled={busy}>Save Review</button>
                    {asset.custodyEvents?.length ? (
                      <div className="reward-list" style={{ marginTop: 12 }}>
                        {asset.custodyEvents.slice(-4).map((event) => (
                          <article key={event.id} className="reward-item">
                            <strong>{event.eventType}</strong>
                            <p className="muted">{new Date(event.createdAt).toLocaleString()} | Actor: {event.actorUserId || "System"}</p>
                          </article>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="panel card">
          <h2>Upload Evidence</h2>
          <p className="muted">Attach originals to a Polling Unit, incident, or election report. Server SHA-256 is authoritative.</p>
          <div className="form">
            <label className="field">
              <span>File</span>
              <input type="file" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
            </label>
            <label className="field">
              <span>Type</span>
              <select value={uploadDraft.evidenceType} onChange={(event) => setUploadDraft((current) => ({ ...current, evidenceType: event.target.value as EvidenceType }))}>
                {EVIDENCE_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Classification</span>
              <select value={uploadDraft.classification} onChange={(event) => setUploadDraft((current) => ({ ...current, classification: event.target.value as EvidenceClassification }))}>
                {EVIDENCE_CLASSIFICATIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Polling Unit ID</span>
              <input value={uploadDraft.pollingUnitId} onChange={(event) => setUploadDraft((current) => ({ ...current, pollingUnitId: event.target.value }))} />
            </label>
            <label className="field">
              <span>Incident ID</span>
              <input value={uploadDraft.incidentId} onChange={(event) => setUploadDraft((current) => ({ ...current, incidentId: event.target.value }))} />
            </label>
            <label className="field">
              <span>Election Report ID</span>
              <input value={uploadDraft.electionReportId} onChange={(event) => setUploadDraft((current) => ({ ...current, electionReportId: event.target.value }))} />
            </label>
            <label className="field">
              <span>Captured At</span>
              <input type="datetime-local" value={uploadDraft.capturedAt} onChange={(event) => setUploadDraft((current) => ({ ...current, capturedAt: event.target.value }))} />
            </label>
            <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              <label className="field">
                <span>Lat</span>
                <input value={uploadDraft.latitude} onChange={(event) => setUploadDraft((current) => ({ ...current, latitude: event.target.value }))} />
              </label>
              <label className="field">
                <span>Lng</span>
                <input value={uploadDraft.longitude} onChange={(event) => setUploadDraft((current) => ({ ...current, longitude: event.target.value }))} />
              </label>
              <label className="field">
                <span>Accuracy</span>
                <input value={uploadDraft.accuracyMeters} onChange={(event) => setUploadDraft((current) => ({ ...current, accuracyMeters: event.target.value }))} />
              </label>
            </div>
            <button className="button" type="button" onClick={() => void handleUpload()} disabled={busy}>Finalize Upload</button>
          </div>
        </aside>
      </section>

      <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <section className="panel card">
          <div className="section-head">
            <div>
              <h2>Ward / Constituency Aggregation</h2>
              <p className="muted">Roll up visible evidence by command territory.</p>
            </div>
            <label className="field">
              <span>Group</span>
              <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}>
                {groupOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          </div>
          <button className="button secondary" type="button" onClick={() => void handleFilter()} disabled={busy}>Refresh aggregation</button>
          <div className="reward-list" style={{ marginTop: 12 }}>
            {aggregation.slice(0, 8).map((item) => (
              <article key={`${item.territoryKind}-${item.territoryId}`} className="reward-item">
                <strong>{item.territoryId}</strong>
                <p>{item.evidenceCount} evidence asset(s)</p>
                <p className="muted">Latest: {item.latestServerReceivedAt ? new Date(item.latestServerReceivedAt).toLocaleString() : "N/A"}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel card">
          <h2>PU Timeline and Dossier</h2>
          <p className="muted">Reconstruct a Polling Unit record from activities, incidents, reports, evidence, custody, and hashes.</p>
          <div className="action-row">
            <label className="field" style={{ flex: 1 }}>
              <span>Polling Unit ID</span>
              <input value={timelinePollingUnitId} onChange={(event) => setTimelinePollingUnitId(event.target.value)} />
            </label>
            <button className="button" type="button" onClick={() => void handleTimeline()} disabled={busy} style={{ alignSelf: "end" }}>Load</button>
          </div>
          {dossier ? (
            <div className="reward-list" style={{ marginTop: 12 }}>
              <article className="reward-item">
                <strong>Dossier completeness</strong>
                <p>{dossier.completeness.evidenceCount} evidence | {dossier.completeness.incidentCount} incidents | {dossier.completeness.reportCount} reports | {dossier.completeness.custodyEventCount} custody events</p>
              </article>
              {timeline.slice(0, 8).map((item) => (
                <article key={`${item.type}-${item.id}-${item.occurredAt}`} className="reward-item">
                  <strong>{item.type}</strong>
                  <p>{item.label}</p>
                  <p className="muted">{new Date(item.occurredAt).toLocaleString()} {item.sha256 ? `| ${compactHash(item.sha256)}` : ""}</p>
                </article>
              ))}
            </div>
          ) : null}
        </section>

        <section className="panel card">
          <h2>Legal Support and Export</h2>
          <p className="muted">Workspaces organize evidence for review only. Exports are manifest-only until archive packaging is implemented.</p>
          <div className="form">
            <label className="field">
              <span>Workspace Title</span>
              <input value={legalTitle} onChange={(event) => setLegalTitle(event.target.value)} />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea rows={2} value={legalDescription} onChange={(event) => setLegalDescription(event.target.value)} />
            </label>
            <button className="button secondary" type="button" onClick={() => void handleCreateLegalCase()} disabled={busy}>Create Case From Selection</button>
            <label className="field">
              <span>Existing Workspace</span>
              <select value={selectedLegalCaseId} onChange={(event) => setSelectedLegalCaseId(event.target.value)}>
                <option value="">No workspace</option>
                {legalCases.map((item) => <option key={item.id} value={item.id}>{item.title} ({item.evidenceCount})</option>)}
              </select>
            </label>
            <label className="field">
              <span>Export Purpose</span>
              <textarea rows={2} value={exportPurpose} onChange={(event) => setExportPurpose(event.target.value)} />
            </label>
            <button className="button" type="button" onClick={() => void handleExport()} disabled={busy}>Generate Controlled Manifest</button>
            <button className="button secondary" type="button" onClick={() => void handleVerifyManifest()} disabled={busy || !lastManifest}>Verify Manifest SHA-256</button>
            {lastManifest ? (
              <article className="reward-item">
                <strong>Last manifest</strong>
                <p>{lastManifest.manifest.items.length} item(s)</p>
                <p className="muted">{lastManifest.manifestSha256}</p>
                <p className="muted">{lastManifest.manifest.archivePackagingStatus}</p>
              </article>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}
