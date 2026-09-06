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
import {
  DataTable,
  DetailList,
  EmptyRow,
  Field,
  Kpi,
  KpiRow,
  PageHead,
  Panel,
  PanelGrid,
  StateView,
  StatusPill,
  Toolbar,
  ToolbarField,
  formatCount,
} from "../../../components/ui";
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
  const [reviewingId, setReviewingId] = useState<string | null>(null);
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
      <main className="console-shell">
        <PageHead title="Evidence" />
        <StateView kind="loading" title="Loading evidence workspace…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Evidence" />
        <StateView
          kind="error"
          title="Unable to load evidence"
          detail={feedback.message || "Authentication is required."}
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
        title="Evidence explorer"
        lead={`Visible scope: ${describeTerritory(
          user.adminProfile ||
            user.coordinatorProfile || {
              geoPoliticalZoneId: null,
              stateId: null,
              senatorialDistrictId: null,
              federalConstituencyId: null,
              lgaId: null,
              wardId: null,
              stateConstituencyId: null,
              pollingUnitId: null,
            },
        )} · Originals remain private and immutable. Every view, download, review, case association and export is backend-authorised and audited.`}
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        <FeedbackBanner tone={feedback.tone} message={feedback.message} />

        <KpiRow>
          <Kpi label="Total evidence" value={formatCount(summary.total)} note="In your visible scope" />
          <Kpi label="Returned" value={formatCount(summary.returned)} note="Matching the current filters" />
          <Kpi
            label="Selected"
            value={formatCount(selectedEvidenceIds.length)}
            note="For case association or export"
            tone={selectedEvidenceIds.length > 0 ? "accent" : undefined}
          />
          <Kpi label="Legal workspaces" value={formatCount(legalCases.length)} />
        </KpiRow>

        <Panel
          title="Search and filters"
          meta="Filters are enforced again by the API"
          actions={
            <button className="btn btn-sm btn-primary" type="button" onClick={() => void handleFilter()} disabled={busy || loading}>
              {loading ? "Loading…" : "Apply filters"}
            </button>
          }
        >
          <div className="form-grid">
            <Field label="Search" hint="ID, file name, hash, incident, report or Polling Unit.">
              <input
                type="search"
                value={filters.search}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              />
            </Field>
            <Field label="Evidence type">
              <select
                value={filters.evidenceType}
                onChange={(event) => setFilters((current) => ({ ...current, evidenceType: event.target.value as Filters["evidenceType"] }))}
              >
                <option value="">All types</option>
                {EVIDENCE_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Classification">
              <select
                value={filters.classification}
                onChange={(event) => setFilters((current) => ({ ...current, classification: event.target.value as Filters["classification"] }))}
              >
                <option value="">All classifications</option>
                {EVIDENCE_CLASSIFICATIONS.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Review status">
              <select
                value={filters.reviewStatus}
                onChange={(event) => setFilters((current) => ({ ...current, reviewStatus: event.target.value as Filters["reviewStatus"] }))}
              >
                <option value="">All statuses</option>
                {EVIDENCE_REVIEW_STATUSES.map((option) => (
                  <option key={option} value={option}>
                    {option.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Polling Unit ID">
              <input
                value={filters.pollingUnitId}
                onChange={(event) => setFilters((current) => ({ ...current, pollingUnitId: event.target.value }))}
              />
            </Field>
            <Field label="Incident ID">
              <input
                value={filters.incidentId}
                onChange={(event) => setFilters((current) => ({ ...current, incidentId: event.target.value }))}
              />
            </Field>
            <Field label="Report ID">
              <input
                value={filters.electionReportId}
                onChange={(event) => setFilters((current) => ({ ...current, electionReportId: event.target.value }))}
              />
            </Field>
            <Field label="SHA-256">
              <input
                value={filters.sha256}
                onChange={(event) => setFilters((current) => ({ ...current, sha256: event.target.value }))}
              />
            </Field>
            <Field label="Date from">
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))}
              />
            </Field>
            <Field label="Date to">
              <input
                type="date"
                value={filters.dateTo}
                onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))}
              />
            </Field>
          </div>
        </Panel>

        <div className="workbench">
          <Panel
            title="Scoped evidence"
            meta={`${formatCount(evidence.length)} visible`}
            flush
          >
            <DataTable
              head={
                <tr>
                  <th className="select-col">
                    <span className="sr-only">Select</span>
                  </th>
                  <th>File</th>
                  <th>Type</th>
                  <th>Classification</th>
                  <th>Review</th>
                  <th>Location</th>
                  <th>Received</th>
                  <th className="actions">Action</th>
                </tr>
              }
            >
              {evidence.length === 0 ? (
                <EmptyRow colSpan={8}>No evidence matches the current scope and filters.</EmptyRow>
              ) : (
                evidence.flatMap((asset) => {
                  const draft = reviewDrafts[asset.id] || {
                    status: asset.reviewStatus,
                    classification: asset.classification,
                    note: "",
                  };
                  const open = reviewingId === asset.id;
                  const rows = [
                    <tr key={asset.id} className={open ? "row-open" : undefined}>
                      <td className="select-col">
                        <span className="select-cell">
                          <input
                            type="checkbox"
                            aria-label={`Select ${asset.originalFileName}`}
                            checked={selectedEvidenceIds.includes(asset.id)}
                            onChange={() => toggleSelected(asset.id)}
                          />
                        </span>
                      </td>
                      <td>
                        <strong>{asset.originalFileName}</strong>
                        <div className="mono">{compactHash(asset.sha256)}</div>
                        {!asset.preservation.originalImmutable ? (
                          <span className="pill pill-error">original not immutable</span>
                        ) : null}
                      </td>
                      <td className="muted-text">{asset.evidenceType.replace(/_/g, " ").toLowerCase()}</td>
                      <td className="muted-text">{asset.classification.replace(/_/g, " ").toLowerCase()}</td>
                      <td>
                        <StatusPill status={asset.reviewStatus} />
                      </td>
                      <td className="muted-text">
                        {asset.territory.pollingUnitId ? `PU ${asset.territory.pollingUnitId}` : "—"}
                        {asset.incidentId ? <div>Incident {asset.incidentId}</div> : null}
                        {asset.electionReportId ? <div>Report {asset.electionReportId}</div> : null}
                      </td>
                      <td className="muted-text">{new Date(asset.serverReceivedAt).toLocaleString()}</td>
                      <td className="actions">
                        <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                          <button className="btn btn-sm" type="button" onClick={() => void handleAccess(asset.id, "VIEW")} disabled={busy}>
                            View
                          </button>
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => void handleAccess(asset.id, "DOWNLOAD")}
                            disabled={busy}
                          >
                            Download
                          </button>
                          <button
                            className="btn btn-sm"
                            type="button"
                            aria-expanded={open}
                            onClick={() => setReviewingId(open ? null : asset.id)}
                          >
                            {open ? "Close" : "Review"}
                          </button>
                        </span>
                      </td>
                    </tr>,
                  ];

                  if (open) {
                    rows.push(
                      <tr key={`${asset.id}-editor`} className="row-editor">
                        <td colSpan={8}>
                          <div className="stack-3">
                            <div className="form-grid">
                              <Field label="Next status">
                                <select
                                  value={draft.status}
                                  onChange={(event) =>
                                    setReviewDrafts((current) => ({
                                      ...current,
                                      [asset.id]: { ...draft, status: event.target.value as EvidenceReviewStatus },
                                    }))
                                  }
                                >
                                  {EVIDENCE_REVIEW_STATUSES.map((option) => (
                                    <option key={option} value={option}>
                                      {option.replace(/_/g, " ").toLowerCase()}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                              <Field label="Classification">
                                <select
                                  value={draft.classification}
                                  onChange={(event) =>
                                    setReviewDrafts((current) => ({
                                      ...current,
                                      [asset.id]: { ...draft, classification: event.target.value as EvidenceClassification },
                                    }))
                                  }
                                >
                                  {EVIDENCE_CLASSIFICATIONS.map((option) => (
                                    <option key={option} value={option}>
                                      {option.replace(/_/g, " ").toLowerCase()}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                            </div>
                            <Field label="Review note">
                              <textarea
                                rows={2}
                                value={draft.note}
                                onChange={(event) =>
                                  setReviewDrafts((current) => ({
                                    ...current,
                                    [asset.id]: { ...draft, note: event.target.value },
                                  }))
                                }
                              />
                            </Field>
                            <div className="split">
                              <span className="mono">SHA-256 {asset.sha256}</span>
                              <span className="split-end">
                                <button className="btn btn-primary" type="button" onClick={() => void handleReview(asset.id)} disabled={busy}>
                                  Save review
                                </button>
                              </span>
                            </div>
                            {asset.custodyEvents?.length ? (
                              <DetailList
                                rows={asset.custodyEvents.slice(-4).map((event) => ({
                                  label: event.eventType.replace(/_/g, " "),
                                  value: `${new Date(event.createdAt).toLocaleString()} · ${event.actorUserId || "System"}`,
                                }))}
                              />
                            ) : null}
                          </div>
                        </td>
                      </tr>,
                    );
                  }

                  return rows;
                })
              )}
            </DataTable>
          </Panel>

          <Panel title="Upload evidence" meta="Server SHA-256 is authoritative">
            <div className="stack-3">
              <Field label="File">
                <input type="file" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
              </Field>
              <div className="form-grid">
                <Field label="Type">
                  <select
                    value={uploadDraft.evidenceType}
                    onChange={(event) => setUploadDraft((current) => ({ ...current, evidenceType: event.target.value as EvidenceType }))}
                  >
                    {EVIDENCE_TYPES.map((option) => (
                      <option key={option} value={option}>
                        {option.replace(/_/g, " ").toLowerCase()}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Classification">
                  <select
                    value={uploadDraft.classification}
                    onChange={(event) =>
                      setUploadDraft((current) => ({ ...current, classification: event.target.value as EvidenceClassification }))
                    }
                  >
                    {EVIDENCE_CLASSIFICATIONS.map((option) => (
                      <option key={option} value={option}>
                        {option.replace(/_/g, " ").toLowerCase()}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Polling Unit ID" hint="Attach the original to a Polling Unit, incident or report.">
                <input
                  value={uploadDraft.pollingUnitId}
                  onChange={(event) => setUploadDraft((current) => ({ ...current, pollingUnitId: event.target.value }))}
                />
              </Field>
              <Field label="Incident ID">
                <input
                  value={uploadDraft.incidentId}
                  onChange={(event) => setUploadDraft((current) => ({ ...current, incidentId: event.target.value }))}
                />
              </Field>
              <Field label="Election report ID">
                <input
                  value={uploadDraft.electionReportId}
                  onChange={(event) => setUploadDraft((current) => ({ ...current, electionReportId: event.target.value }))}
                />
              </Field>
              <Field label="Captured at">
                <input
                  type="datetime-local"
                  value={uploadDraft.capturedAt}
                  onChange={(event) => setUploadDraft((current) => ({ ...current, capturedAt: event.target.value }))}
                />
              </Field>
              <div className="form-grid">
                <Field label="Latitude">
                  <input
                    value={uploadDraft.latitude}
                    onChange={(event) => setUploadDraft((current) => ({ ...current, latitude: event.target.value }))}
                  />
                </Field>
                <Field label="Longitude">
                  <input
                    value={uploadDraft.longitude}
                    onChange={(event) => setUploadDraft((current) => ({ ...current, longitude: event.target.value }))}
                  />
                </Field>
                <Field label="Accuracy (m)">
                  <input
                    value={uploadDraft.accuracyMeters}
                    onChange={(event) => setUploadDraft((current) => ({ ...current, accuracyMeters: event.target.value }))}
                  />
                </Field>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" type="button" onClick={() => void handleUpload()} disabled={busy}>
                  Finalise upload
                </button>
              </div>
            </div>
          </Panel>
        </div>

        <PanelGrid>
          <Panel
            title="Territory aggregation"
            actions={
              <button className="btn btn-sm" type="button" onClick={() => void handleFilter()} disabled={busy}>
                Refresh
              </button>
            }
            flush
          >
            <Toolbar>
              <ToolbarField label="Group by">
                <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}>
                  {groupOptions.map((option) => (
                    <option key={option} value={option}>
                      {option.replace(/_/g, " ").toLowerCase()}
                    </option>
                  ))}
                </select>
              </ToolbarField>
            </Toolbar>
            <DataTable
              head={
                <tr>
                  <th>Territory</th>
                  <th className="numeric">Assets</th>
                  <th>Latest received</th>
                </tr>
              }
            >
              {aggregation.length === 0 ? (
                <EmptyRow colSpan={3}>No evidence to roll up in this scope.</EmptyRow>
              ) : (
                aggregation.slice(0, 12).map((item) => (
                  <tr key={`${item.territoryKind}-${item.territoryId}`}>
                    <td>{item.territoryId}</td>
                    <td className="numeric">{formatCount(item.evidenceCount)}</td>
                    <td className="muted-text">
                      {item.latestServerReceivedAt ? new Date(item.latestServerReceivedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>

          <Panel title="Polling Unit dossier" meta="Reconstructed from activities, incidents, reports, evidence and custody">
            <div className="stack-3">
              <div className="split">
                <Field label="Polling Unit ID">
                  <input value={timelinePollingUnitId} onChange={(event) => setTimelinePollingUnitId(event.target.value)} />
                </Field>
                <span className="split-end">
                  <button className="btn" type="button" onClick={() => void handleTimeline()} disabled={busy}>
                    Load
                  </button>
                </span>
              </div>

              {dossier ? (
                <>
                  <DetailList
                    rows={[
                      { label: "Evidence", value: formatCount(dossier.completeness.evidenceCount) },
                      { label: "Incidents", value: formatCount(dossier.completeness.incidentCount) },
                      { label: "Reports", value: formatCount(dossier.completeness.reportCount) },
                      { label: "Custody events", value: formatCount(dossier.completeness.custodyEventCount) },
                    ]}
                  />
                  <DataTable
                    caption="Timeline"
                    head={
                      <tr>
                        <th>Type</th>
                        <th>Entry</th>
                        <th>When</th>
                      </tr>
                    }
                  >
                    {timeline.length === 0 ? (
                      <EmptyRow colSpan={3}>No timeline entries.</EmptyRow>
                    ) : (
                      timeline.slice(0, 10).map((item) => (
                        <tr key={`${item.type}-${item.id}-${item.occurredAt}`}>
                          <td className="muted-text">{item.type.replace(/_/g, " ").toLowerCase()}</td>
                          <td>
                            {item.label}
                            {item.sha256 ? <div className="mono">{compactHash(item.sha256)}</div> : null}
                          </td>
                          <td className="muted-text">{new Date(item.occurredAt).toLocaleString()}</td>
                        </tr>
                      ))
                    )}
                  </DataTable>
                </>
              ) : (
                <StateView kind="empty" title="Load a Polling Unit to reconstruct its dossier" />
              )}
            </div>
          </Panel>

          <Panel title="Legal support and export" meta="Exports are manifest-only until archive packaging exists">
            <div className="stack-3">
              <Field label="Workspace title">
                <input value={legalTitle} onChange={(event) => setLegalTitle(event.target.value)} />
              </Field>
              <Field label="Description">
                <textarea rows={2} value={legalDescription} onChange={(event) => setLegalDescription(event.target.value)} />
              </Field>
              <div className="btn-row">
                <button className="btn" type="button" onClick={() => void handleCreateLegalCase()} disabled={busy}>
                  Create case from selection
                </button>
              </div>
              <Field label="Existing workspace">
                <select value={selectedLegalCaseId} onChange={(event) => setSelectedLegalCaseId(event.target.value)}>
                  <option value="">No workspace</option>
                  {legalCases.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} ({item.evidenceCount})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Export purpose" hint="Recorded with the manifest.">
                <textarea rows={2} value={exportPurpose} onChange={(event) => setExportPurpose(event.target.value)} />
              </Field>
              <div className="btn-row">
                <button className="btn btn-primary" type="button" onClick={() => void handleExport()} disabled={busy}>
                  Generate controlled manifest
                </button>
                <button className="btn" type="button" onClick={() => void handleVerifyManifest()} disabled={busy || !lastManifest}>
                  Verify manifest SHA-256
                </button>
              </div>
              {lastManifest ? (
                <DetailList
                  rows={[
                    { label: "Items", value: formatCount(lastManifest.manifest.items.length) },
                    { label: "Manifest SHA-256", value: <span className="mono">{lastManifest.manifestSha256}</span> },
                    { label: "Packaging", value: lastManifest.manifest.archivePackagingStatus },
                  ]}
                />
              ) : null}
            </div>
          </Panel>
        </PanelGrid>
      </div>
    </main>
  );
}
