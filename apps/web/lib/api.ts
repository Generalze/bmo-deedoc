import type {
  AdminUserItem,
  AgentUserItem,
  AdminDashboardSummary,
  AdminMapSummary,
  AgentActivitySummary,
  AuthUserProfile,
  AuditLogItem,
  BroadcastMessageItem,
  BroadcastAudiencePreview,
  CampaignEventItem,
  CandidateProfileEditorItem,
  CandidatePublicListItem,
  CandidatePublicProfile,
  CandidateVoterItem,
  CandidateListItem,
  FieldTaskItem,
  FeedbackListItem,
  GeoPoliticalZoneItem,
  IncidentListItem,
  IncidentGovernanceSummary,
  LgaItem,
  ManagedUserItem,
  NotificationItem,
  OgunOrganizationTree,
  PollingUnitItem,
  PollingUnitCoverageSummary,
  CoverageInsights,
  ElectionDayReportAssetItem,
  ElectionDayReportItem,
  ElectionDayConversationItem,
  ElectionDayMessageItem,
  ElectionDayOperationalAlertItem,
  ElectionDaySituationRoomStatus,
  ElectionDayTimelineItem,
  ElectionDayWebrtcConfig,
  ElectionDayCallItem,
  DashboardLevel,
  HierarchicalDashboard,
  LeaderboardMetric,
  VoiceCallSignalType,
  VoiceCallStatus,
  EvidenceAggregationItem,
  EvidenceAssetItem,
  EvidenceClassification,
  EvidenceDossier,
  EvidenceExplorerSummary,
  EvidenceManifest,
  EvidencePackageItem,
  EvidenceReviewStatus,
  EvidenceTimelineItem,
  EvidenceType,
  PoliticalPartyItem,
  PoliticalPartyPublicProfile,
  PollListItem,
  PostListItem,
  RewardBalanceSummary,
  RewardHistoryItem,
  RewardLedgerItem,
  RewardRedemptionItem,
  RewardsSummary,
  TerritorySummary,
  ReferenceCompletenessReport,
  SenatorialDistrictItem,
  StateItem,
  StateConstituencyItem,
  FederalConstituencyItem,
  VoterEngagementTaskItem,
  VoterUserItem,
  WardItem,
  RealtimePresenceEntry,
  LegalCaseItem,
} from "@pics-nigeria/shared";

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function getApiBaseUrl(): string {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();

  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }

  if (process.env.NODE_ENV !== "production") {
    return "http://localhost:4000";
  }

  throw new Error("Missing NEXT_PUBLIC_API_BASE_URL for production build.");
}

const API_BASE_URL = getApiBaseUrl();

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok) {
    throw new ApiError(payload.message || "Request failed.", response.status, payload);
  }
  return payload as T;
}

export async function loginUser(
  email: string,
  password: string,
  options?: { agentGpsConsent?: boolean },
): Promise<{ token: string; user: AuthUserProfile }> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, agentGpsConsent: options?.agentGpsConsent }),
  });

  return readJson<{ token: string; user: AuthUserProfile }>(response);
}

export async function registerVoterUser(body: {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  voterCardNumber: string;
  stateId: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  stateConstituencyId?: string;
  lgaId: string;
  wardId: string;
  pollingUnitId: string;
  referredByCode?: string;
  acceptTerms: true;
  acceptPrivacy?: true;
  contactConsent: true;
  documentProcessingConsent?: true;
  confirmAdult: true;
  consentVersion?: string;
  voterDocument?: {
    originalStorageKey: string;
    originalFileName: string;
    mimeType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
    fileSize: number;
    sha256: string;
  };
}): Promise<{ message: string; user: AuthUserProfile }> {
  const response = await fetch(`${API_BASE_URL}/auth/register-voter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; user: AuthUserProfile }>(response);
}

export type PreElectionVerificationCase = {
  id: string;
  memberUserId: string;
  memberName: string;
  memberEmail: string;
  memberPhone: string | null;
  voterIdentifier: string;
  status: string;
  isFlagged: boolean;
  fraudReason: string | null;
  submittedAt: string | null;
  reviewStartedAt: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  territory: TerritorySummary | null;
  documents: Array<{
    id: string;
    originalFileName: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    storageProvider: string;
    uploadedAt: string;
  }>;
  history: Array<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    decision: string;
    note: string | null;
    actorName: string | null;
    createdAt: string;
  }>;
};

export type PreElectionReferralItem = {
  id: string;
  referredUserId: string;
  referredName: string;
  referredEmail: string;
  referrerUserId: string;
  referrerName: string;
  referrerEmail: string;
  referralCode: string;
  status: string;
  wardId: string | null;
  pollingUnitId: string | null;
  registeredAt: string;
  qualifiedAt: string | null;
  rewardProcessedAt: string | null;
  flaggedAt: string | null;
  fraudReason: string | null;
};

export type PreElectionRewardLedgerEntry = {
  id: string;
  userId: string;
  points: number;
  category: string;
  sourceEventType: string;
  sourceEventId: string;
  rewardRuleVersionId: string | null;
  rewardRuleName: string | null;
  rewardRuleVersion: number | null;
  relatedUserId: string | null;
  relatedUserName: string | null;
  relatedUserEmail: string | null;
  description: string | null;
  createdAt: string;
};

export type PreElectionPayoutAssignment = {
  id: string;
  payoutCycleId: string;
  payoutBatchId: string;
  payoutOfficerUserId: string;
  payoutOfficerName: string | null;
  beneficiaryUserId: string;
  beneficiaryName: string | null;
  beneficiaryEmail: string | null;
  points: number;
  amount: string;
  status: string;
  assignedAt: string;
  processedAt: string | null;
  note: string | null;
  transactions: Array<{
    id: string;
    paymentReference: string;
    pointsRedeemed: number;
    amountPaid: string;
    status: string;
    proofStorageKey: string | null;
    note: string | null;
    createdAt: string;
  }>;
};

export type PreElectionPayoutBatch = {
  id: string;
  payoutCycleId: string;
  payoutCycleName: string | null;
  payoutDate: string | null;
  status: string;
  createdAt: string;
  approvedAt: string | null;
  assignmentCount: number;
  totalPoints: number;
  totalAmount: string;
  assignments: PreElectionPayoutAssignment[];
};

export type PreElectionStrengthDashboard = {
  territoryType: string;
  territoryId: string;
  latestStrengthSnapshot: {
    id: string;
    score: string;
    trend: string;
    calculatedAt: string;
    breakdownJson: unknown;
  } | null;
  targetProgress: Array<{
    targetId: string;
    metric: string;
    territoryType: string;
    territoryId: string;
    targetValue: number;
    actualValue: number;
    percentageAchieved: number;
    shortfall: number;
  }>;
  childSummaries: Array<{
    territoryType: string;
    territoryId: string;
    name: string;
    latestScore: string | null;
    latestScoreAt: string | null;
    verifiedMembers: number;
    registeredMembers: number;
  }>;
  coordinatorPerformance: Array<{
    userId: string;
    name: string;
    email: string;
    level: string;
    directRegistrations: number;
    directVerifiedRegistrations: number;
    confirmedPoints: number;
  }>;
};

export async function fetchPublicStates(): Promise<StateItem[]> {
  const response = await fetch(`${API_BASE_URL}/auth/territories/states`, {
    cache: "no-store",
  });

  const payload = await readJson<{ states: StateItem[] }>(response);
  return payload.states;
}

export async function fetchPublicLgas(stateId: string): Promise<LgaItem[]> {
  const response = await fetch(`${API_BASE_URL}/auth/territories/lgas?stateId=${encodeURIComponent(stateId)}`, {
    cache: "no-store",
  });

  const payload = await readJson<{ lgas: LgaItem[] }>(response);
  return payload.lgas;
}

export async function fetchPublicWards(stateId: string, lgaId: string): Promise<WardItem[]> {
  const query = new URLSearchParams({ stateId, lgaId });
  const response = await fetch(`${API_BASE_URL}/auth/territories/wards?${query.toString()}`, {
    cache: "no-store",
  });

  const payload = await readJson<{ wards: WardItem[] }>(response);
  return payload.wards;
}

export async function fetchPublicPollingUnits(stateId: string, lgaId: string, wardId: string): Promise<PollingUnitItem[]> {
  const query = new URLSearchParams({ stateId, lgaId, wardId });
  const response = await fetch(`${API_BASE_URL}/auth/territories/polling-units?${query.toString()}`, {
    cache: "no-store",
  });

  const payload = await readJson<{ pollingUnits: PollingUnitItem[] }>(response);
  return payload.pollingUnits;
}

export async function fetchCurrentUser(token: string): Promise<AuthUserProfile> {
  const response = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ user: AuthUserProfile }>(response);
  return payload.user;
}

export async function fetchPreElectionReferralCode(token: string): Promise<{ referralCode: string; referralLink: string }> {
  const response = await fetch(`${API_BASE_URL}/pre-election/referral-code`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return readJson<{ referralCode: string; referralLink: string }>(response);
}

export async function fetchMyPreElectionVerification(token: string): Promise<PreElectionVerificationCase | null> {
  const response = await fetch(`${API_BASE_URL}/pre-election/verifications/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ verification: PreElectionVerificationCase | null }>(response);
  return payload.verification;
}

export async function submitMyPreElectionVerificationDocument(
  token: string,
  body: {
    documentProcessingConsent: true;
    voterDocument: {
      originalStorageKey: string;
      originalFileName: string;
      mimeType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
      fileSize: number;
      sha256: string;
    };
  },
) {
  const response = await fetch(`${API_BASE_URL}/pre-election/verifications/me/documents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; verificationId: string; status: string }>(response);
}

export async function fetchPreElectionVerifications(
  token: string,
  query?: { status?: string; flagged?: boolean; search?: string; territoryType?: string; territoryId?: string },
): Promise<PreElectionVerificationCase[]> {
  const params = new URLSearchParams();
  if (query?.status) params.set("status", query.status);
  if (query?.flagged !== undefined) params.set("flagged", String(query.flagged));
  if (query?.search) params.set("search", query.search);
  if (query?.territoryType) params.set("territoryType", query.territoryType);
  if (query?.territoryId) params.set("territoryId", query.territoryId);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/pre-election/verifications${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ verifications: PreElectionVerificationCase[] }>(response);
  return payload.verifications;
}

export async function exportPreElectionVerificationsCsv(token: string, query?: { status?: string; search?: string }) {
  const params = new URLSearchParams({ export: "csv" });
  if (query?.status) params.set("status", query.status);
  if (query?.search) params.set("search", query.search);
  const response = await fetch(`${API_BASE_URL}/pre-election/verifications?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new ApiError("Verification export failed.", response.status);
  }
  return response.text();
}

export async function claimPreElectionVerification(token: string, verificationId: string) {
  const response = await fetch(`${API_BASE_URL}/pre-election/verifications/${verificationId}/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return readJson<{ message: string; verificationId: string }>(response);
}

export async function accessPreElectionVerificationDocument(token: string, verificationId: string, documentId: string) {
  const response = await fetch(`${API_BASE_URL}/pre-election/verifications/${verificationId}/documents/${documentId}/access`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return readJson<{ storageProvider: string; storageKey: string; accessToken: string; expiresAt: string }>(response);
}

export async function decidePreElectionVerification(
  token: string,
  verificationId: string,
  body: { decision: "APPROVE" | "REJECT" | "REQUEST_RESUBMISSION"; note?: string },
) {
  const response = await fetch(`${API_BASE_URL}/pre-election/verifications/${verificationId}/decision`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; verificationId: string; status: string }>(response);
}

export async function fetchPreElectionReferrals(
  token: string,
  query?: { status?: string; search?: string; territoryType?: string; territoryId?: string },
) {
  const params = new URLSearchParams();
  if (query?.status) params.set("status", query.status);
  if (query?.search) params.set("search", query.search);
  if (query?.territoryType) params.set("territoryType", query.territoryType);
  if (query?.territoryId) params.set("territoryId", query.territoryId);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/pre-election/referrals${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return readJson<{
    referrals: PreElectionReferralItem[];
    summary: Record<string, number>;
  }>(response);
}

export async function fetchPreElectionRewardBalance(token: string, userId?: string) {
  const suffix = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  const response = await fetch(`${API_BASE_URL}/pre-election/rewards/balance${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return readJson<{
    userId: string;
    confirmedPoints: number;
    pendingPotentialPoints: number;
    reservedPayoutPoints: number;
    availablePoints: number;
    /** Preserved legacy value awaiting an approved ratio. Never spendable. */
    legacyCarryoverPendingPoints: number;
    /** Legacy value already converted; included in confirmedPoints. */
    legacyCarryoverConfirmedPoints: number;
    /** Legacy-era claims counted in reservedPayoutPoints. Diagnostic only. */
    preCutoverReservedPoints: number;
    payablePoints: number;
  }>(response);
}

export async function fetchPreElectionRewardLedger(token: string, userId?: string): Promise<PreElectionRewardLedgerEntry[]> {
  const suffix = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  const response = await fetch(`${API_BASE_URL}/pre-election/rewards/ledger${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ rewardLedgerEntries: PreElectionRewardLedgerEntry[] }>(response);
  return payload.rewardLedgerEntries;
}

export async function fetchPreElectionPayoutOfficers(token: string): Promise<Array<{ id: string; name: string; email: string }>> {
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/officers`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ payoutOfficers: Array<{ id: string; name: string; email: string }> }>(response);
  return payload.payoutOfficers;
}

export async function createPreElectionPayoutConfiguration(
  token: string,
  body: { minimumPoints: number; pointConversionRate: number; frequency: string; nextPayoutDate?: string },
) {
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/configurations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function fetchPreElectionPayoutCycles(token: string) {
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/cycles`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return readJson<{ payoutCycles: Array<{ id: string; name: string; status: string; payoutDate: string; minimumThreshold: number; conversionRate: string }> }>(response);
}

export async function createPreElectionPayoutCycle(
  token: string,
  // No minimumThreshold and no conversionRate: the server snapshots a cycle's
  // monetary terms from the active payout configuration.
  body: { name: string; opensAt: string; closesAt: string; payoutDate: string },
) {
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/cycles`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function fetchPreElectionPayoutEligibility(token: string, cycleId?: string) {
  const suffix = cycleId ? `?cycleId=${encodeURIComponent(cycleId)}` : "";
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/eligibility${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return readJson<{
    payoutEligibility: Array<{ userId: string; name: string | null; email: string | null; availablePoints: number; amount: string }>;
    minimumThreshold: number;
    conversionRate: string;
  }>(response);
}

export async function createPreElectionPayoutBatch(
  token: string,
  cycleId: string,
  body: { payoutOfficerUserId: string; beneficiaryUserIds?: string[] },
) {
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/cycles/${cycleId}/batches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function fetchPreElectionPayoutBatches(token: string, status?: string): Promise<PreElectionPayoutBatch[]> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/batches${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ payoutBatches: PreElectionPayoutBatch[] }>(response);
  return payload.payoutBatches;
}

export async function approvePreElectionPayoutBatch(token: string, batchId: string) {
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/batches/${batchId}/approve`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  });
  return readJson(response);
}

export async function fetchPreElectionPayoutAssignments(token: string, status?: string): Promise<PreElectionPayoutAssignment[]> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/assignments${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ payoutAssignments: PreElectionPayoutAssignment[] }>(response);
  return payload.payoutAssignments;
}

export async function updatePreElectionPayoutAssignment(
  token: string,
  assignmentId: string,
  body: { status: "PROCESSING" | "PAID" | "HELD" | "REJECTED"; paymentReference?: string; proofStorageKey?: string; note?: string },
) {
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/assignments/${assignmentId}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function createPreElectionRewardRule(
  token: string,
  body: { name: string; directPoints: number; eligibleRole?: string; eligibleCoordinatorLevel?: string },
) {
  const response = await fetch(`${API_BASE_URL}/pre-election/reward-rules`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function fetchPreElectionRewardRules(token: string) {
  const response = await fetch(`${API_BASE_URL}/pre-election/reward-rules`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return readJson<{ rewardRules: Array<{ id: string; name: string; active: boolean; eligibleRole: string; eligibleCoordinatorLevel: string | null; versions: Array<{ version: number; directPoints: number }> }> }>(response);
}

export async function createPreElectionStrengthMetric(token: string, body: { metric: string; description?: string }) {
  const response = await fetch(`${API_BASE_URL}/pre-election/strength/metrics`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function createPreElectionStrengthWeight(token: string, body: { metric: string; weight: number }) {
  const response = await fetch(`${API_BASE_URL}/pre-election/strength/weights`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function createPreElectionTerritoryTarget(
  token: string,
  body: { territoryType: string; territoryId: string; metric: string; targetValue: number; startDate: string; endDate?: string },
) {
  const response = await fetch(`${API_BASE_URL}/pre-election/strength/targets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function calculatePreElectionStrengthSnapshot(token: string, body: { territoryType: string; territoryId: string }) {
  const response = await fetch(`${API_BASE_URL}/pre-election/strength/snapshots/calculate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function fetchPreElectionStrengthDashboard(
  token: string,
  query: { territoryType: string; territoryId: string },
): Promise<PreElectionStrengthDashboard> {
  const params = new URLSearchParams(query);
  const response = await fetch(`${API_BASE_URL}/pre-election/strength/dashboard?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ dashboard: PreElectionStrengthDashboard }>(response);
  return payload.dashboard;
}

export async function fetchOgunOrganizationTree(token: string): Promise<OgunOrganizationTree> {
  const response = await fetch(`${API_BASE_URL}/platform/organization-tree`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ tree: OgunOrganizationTree }>(response);
  return payload.tree;
}

export async function logoutCurrentUser(token: string): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  return readJson<{ message: string }>(response);
}

export async function updateCurrentUserProfile(
  token: string,
  body: { name: string; email: string; phone?: string },
): Promise<{ message: string; user: AuthUserProfile }> {
  const response = await fetch(`${API_BASE_URL}/auth/me`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; user: AuthUserProfile }>(response);
}

export async function updateCurrentUserPassword(
  token: string,
  body: { currentPassword: string; newPassword: string },
): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}/auth/password`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string }>(response);
}

export async function fetchVoterRewards(token: string): Promise<RewardsSummary> {
  const response = await fetch(`${API_BASE_URL}/voter/rewards`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return readJson(response);
}

export async function fetchVoterRewardLedger(
  token: string,
): Promise<{ rewardLedger: RewardLedgerItem[]; rewardHistory: RewardHistoryItem[] }> {
  const response = await fetch(`${API_BASE_URL}/voter/reward-ledger`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return readJson<{ rewardLedger: RewardLedgerItem[]; rewardHistory: RewardHistoryItem[] }>(response);
}

export async function fetchAdminSummary(token: string): Promise<AdminDashboardSummary> {
  const response = await fetch(`${API_BASE_URL}/admin/summary`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ summary: AdminDashboardSummary }>(response);
  return payload.summary;
}

export async function fetchAdminCandidates(token: string): Promise<CandidateListItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/candidates`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ candidates: CandidateListItem[] }>(response);
  return payload.candidates;
}

export async function fetchAdminFeedback(token: string): Promise<FeedbackListItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/feedback`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ feedback: FeedbackListItem[] }>(response);
  return payload.feedback;
}

export async function fetchAdminIncidents(token: string): Promise<IncidentListItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/incidents`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ incidents: IncidentListItem[] }>(response);
  return payload.incidents;
}

export async function fetchAdminIncidentReview(
  token: string,
  query?: { status?: string; type?: string; reviewPriority?: "ROUTINE" | "PRIORITY" | "CRITICAL"; flaggedOnly?: boolean },
): Promise<{ incidents: IncidentListItem[]; governance: IncidentGovernanceSummary }> {
  const params = new URLSearchParams();
  if (query?.status) {
    params.set("status", query.status);
  }
  if (query?.type) {
    params.set("type", query.type);
  }
  if (query?.reviewPriority) {
    params.set("reviewPriority", query.reviewPriority);
  }
  if (query?.flaggedOnly !== undefined) {
    params.set("flaggedOnly", String(query.flaggedOnly));
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/admin/incidents${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return readJson<{ incidents: IncidentListItem[]; governance: IncidentGovernanceSummary }>(response);
}

export async function fetchAdminAgentActivitySummaries(token: string): Promise<AgentActivitySummary[]> {
  const response = await fetch(`${API_BASE_URL}/admin/agent-activity-summaries`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ agentActivitySummaries: AgentActivitySummary[] }>(response);
  return payload.agentActivitySummaries;
}

export async function fetchAdminPollingUnitCoverage(token: string): Promise<PollingUnitCoverageSummary> {
  const response = await fetch(`${API_BASE_URL}/admin/polling-unit-coverage`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ coverage: PollingUnitCoverageSummary }>(response);
  return payload.coverage;
}

export async function fetchAdminCoverageInsights(token: string): Promise<CoverageInsights> {
  const response = await fetch(`${API_BASE_URL}/admin/coverage-insights`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ insights: CoverageInsights }>(response);
  return payload.insights;
}

export async function fetchAdminReferenceCompleteness(token: string): Promise<ReferenceCompletenessReport> {
  const response = await fetch(`${API_BASE_URL}/admin/reference-completeness`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ report: ReferenceCompletenessReport }>(response);
  return payload.report;
}

export async function updateStateAgentTarget(token: string, stateId: string, agentsPerPollingUnitTarget: number): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}/admin/states/${stateId}/agent-target`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agentsPerPollingUnitTarget }),
  });

  return readJson<{ message: string }>(response);
}

export async function fetchAdminMapSummary(token: string): Promise<AdminMapSummary> {
  const response = await fetch(`${API_BASE_URL}/admin/map-summary`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ mapSummary: AdminMapSummary }>(response);
  return payload.mapSummary;
}

export async function fetchAdminAnalytics(token: string) {
  const response = await fetch(`${API_BASE_URL}/admin/analytics`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ analytics: {
    incidentCountsByType: Record<string, number>;
    incidentCountsBySeverity: Record<string, number>;
    incidentCountsByStatus: Record<string, number>;
    agentActivitiesByType: Record<string, number>;
    rewardTotalsByType: Record<string, number>;
    pollResponseTotalsByPoll: Array<{ pollId: string; title: string; responses: number }>;
    voterRegistrationsOverTime: Record<string, number>;
  } }>(response);
  return payload.analytics;
}

export async function fetchAdminRedemptions(token: string): Promise<RewardRedemptionItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/redemptions`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ redemptions: RewardRedemptionItem[] }>(response);
  return payload.redemptions;
}

/**
 * Advance a member redemption.
 *
 * These three had no client at all, so the admin redemption queue rendered rows
 * nobody could act on and the payment reference the API requires had no caller.
 */
export async function approveAdminRedemption(token: string, redemptionId: string, body: { note?: string }) {
  const response = await fetch(`${API_BASE_URL}/admin/redemptions/${encodeURIComponent(redemptionId)}/approve`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; redemption: RewardRedemptionItem }>(response);
}

export async function rejectAdminRedemption(token: string, redemptionId: string, body: { note?: string }) {
  const response = await fetch(`${API_BASE_URL}/admin/redemptions/${encodeURIComponent(redemptionId)}/reject`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; redemption: RewardRedemptionItem }>(response);
}

/**
 * `paymentReference` is required and must come from the operator — it is the
 * identifier that ties this payment to a real bank transaction and makes it
 * non-repeatable. Never generate one.
 */
export async function payAdminRedemption(
  token: string,
  redemptionId: string,
  body: { paymentReference: string; proofStorageKey?: string; note?: string },
) {
  const response = await fetch(`${API_BASE_URL}/admin/redemptions/${encodeURIComponent(redemptionId)}/paid`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; redemption: RewardRedemptionItem }>(response);
}

export type LegacyReconciliationPolicy = {
  id: string;
  version: string;
  conversionRatio: string;
  status: "DRAFT" | "APPROVED" | "RETIRED";
  rationale: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  createdAt: string;
};

export async function fetchLegacyReconciliationPolicies(token: string) {
  const response = await fetch(`${API_BASE_URL}/pre-election/rewards/legacy-reconciliation-policy`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return readJson<{ policies: LegacyReconciliationPolicy[]; approvedPolicyCount: number }>(response);
}

export async function draftLegacyReconciliationPolicy(
  token: string,
  body: { version: string; conversionRatio: number; rationale?: string },
) {
  const response = await fetch(`${API_BASE_URL}/pre-election/rewards/legacy-reconciliation-policy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; policy: LegacyReconciliationPolicy }>(response);
}

export async function approveLegacyReconciliationPolicy(token: string, policyId: string) {
  const response = await fetch(
    `${API_BASE_URL}/pre-election/rewards/legacy-reconciliation-policy/${encodeURIComponent(policyId)}/approve`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return readJson<{ message: string; policy: LegacyReconciliationPolicy }>(response);
}

export type LegacyCarryoverRow = {
  id: string;
  userId: string;
  memberName: string;
  legacyPointBalance: number;
  status: string;
  conversionRatio: string | null;
  reconciliationRuleVersion: string | null;
  creditedPoints: number | null;
  rowChecksum: string;
};

export type LegacyMigrationBatchRow = {
  id: string;
  executedAt: string;
  sourceLedger: string;
  memberCount: number;
  beforeTotalPoints: number;
  migratedTotalPoints: number;
  pendingTotalPoints: number;
  reconciledTotalPoints: number;
  snapshotChecksum: string;
};

export async function fetchLegacyCarryover(token: string) {
  const response = await fetch(`${API_BASE_URL}/pre-election/rewards/legacy-carryover`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return readJson<{ carryovers: LegacyCarryoverRow[]; batches: LegacyMigrationBatchRow[] }>(response);
}

/**
 * The ratio and rule version are NOT sent: the server derives both from the
 * approved policy, and its schema rejects a request that tries to supply them.
 */
export async function reconcileLegacyCarryover(token: string, body: { carryoverId: string; note?: string }) {
  const response = await fetch(`${API_BASE_URL}/pre-election/rewards/legacy-carryover/reconcile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; carryover: Record<string, unknown> }>(response);
}

export async function fetchActivePayoutConfiguration(token: string) {
  const response = await fetch(`${API_BASE_URL}/pre-election/payout/configurations/active`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return readJson<{ payoutConfiguration: { id: string; minimumPoints: number; pointConversionRate: string } | null }>(
    response,
  );
}

export async function fetchAdminRewardLedger(
  token: string,
): Promise<{ rewardLedger: RewardLedgerItem[]; rewardHistory: RewardHistoryItem[] }> {
  const response = await fetch(`${API_BASE_URL}/admin/reward-ledger`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return readJson<{ rewardLedger: RewardLedgerItem[]; rewardHistory: RewardHistoryItem[] }>(response);
}

export async function fetchAdminTasks(token: string): Promise<FieldTaskItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ tasks: FieldTaskItem[] }>(response);
  return payload.tasks;
}

export async function fetchAdminBroadcasts(token: string): Promise<BroadcastMessageItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/broadcasts`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ broadcasts: BroadcastMessageItem[] }>(response);
  return payload.broadcasts;
}

export async function fetchAdminEngagementTasks(token: string): Promise<VoterEngagementTaskItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/engagement-tasks`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ tasks: VoterEngagementTaskItem[] }>(response);
  return payload.tasks;
}

export async function fetchGeoPoliticalZones(token: string): Promise<GeoPoliticalZoneItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/geo-political-zones`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ zones: GeoPoliticalZoneItem[] }>(response);
  return payload.zones;
}

export async function fetchStates(token: string, geoPoliticalZoneId?: string): Promise<StateItem[]> {
  const query = geoPoliticalZoneId ? `?geoPoliticalZoneId=${encodeURIComponent(geoPoliticalZoneId)}` : "";
  const response = await fetch(`${API_BASE_URL}/admin/states${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ states: StateItem[] }>(response);
  return payload.states;
}

export async function fetchSenatorialDistricts(token: string, stateId: string): Promise<SenatorialDistrictItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/senatorial-districts?stateId=${encodeURIComponent(stateId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ districts: SenatorialDistrictItem[] }>(response);
  return payload.districts;
}

export async function fetchFederalConstituencies(
  token: string,
  stateId: string,
  senatorialDistrictId?: string,
): Promise<FederalConstituencyItem[]> {
  const query = new URLSearchParams({ stateId });
  if (senatorialDistrictId) {
    query.set("senatorialDistrictId", senatorialDistrictId);
  }

  const response = await fetch(`${API_BASE_URL}/admin/federal-constituencies?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ constituencies: FederalConstituencyItem[] }>(response);
  return payload.constituencies;
}

export async function fetchLgas(token: string, stateId: string): Promise<LgaItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/lgas?stateId=${encodeURIComponent(stateId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ lgas: LgaItem[] }>(response);
  return payload.lgas;
}

export async function fetchWards(token: string, stateId: string, lgaId?: string): Promise<WardItem[]> {
  const query = new URLSearchParams({ stateId });
  if (lgaId) {
    query.set("lgaId", lgaId);
  }

  const response = await fetch(`${API_BASE_URL}/admin/wards?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ wards: WardItem[] }>(response);
  return payload.wards;
}

export async function fetchStateConstituencies(token: string, stateId: string, lgaId?: string): Promise<StateConstituencyItem[]> {
  const query = new URLSearchParams({ stateId });
  if (lgaId) {
    query.set("lgaId", lgaId);
  }

  const response = await fetch(`${API_BASE_URL}/admin/state-constituencies?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ constituencies: StateConstituencyItem[] }>(response);
  return payload.constituencies;
}

export async function fetchPollingUnits(token: string, stateId: string, lgaId: string, wardId?: string): Promise<PollingUnitItem[]> {
  const query = new URLSearchParams({ stateId, lgaId });
  if (wardId) {
    query.set("wardId", wardId);
  }

  const response = await fetch(`${API_BASE_URL}/admin/polling-units?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ pollingUnits: PollingUnitItem[] }>(response);
  return payload.pollingUnits;
}

export async function fetchAdminUsers(token: string, stateId: string, lgaId?: string): Promise<AdminUserItem[]> {
  const query = new URLSearchParams();
  if (stateId) {
    query.set("stateId", stateId);
  }
  if (lgaId) {
    query.set("lgaId", lgaId);
  }

  const response = await fetch(`${API_BASE_URL}/admin/admin-users?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ adminUsers: AdminUserItem[] }>(response);
  return payload.adminUsers;
}

export async function fetchManagedUsers(
  token: string,
  query?: {
    role?: "ADMIN" | "CANDIDATE" | "AGENT" | "VOTER";
    isActive?: boolean;
    search?: string;
    stateId?: string;
    lgaId?: string;
    wardId?: string;
    limit?: number;
  },
): Promise<ManagedUserItem[]> {
  const params = new URLSearchParams();
  if (query?.role) {
    params.set("role", query.role);
  }
  if (query?.isActive !== undefined) {
    params.set("isActive", String(query.isActive));
  }
  if (query?.search) {
    params.set("search", query.search);
  }
  if (query?.stateId) {
    params.set("stateId", query.stateId);
  }
  if (query?.lgaId) {
    params.set("lgaId", query.lgaId);
  }
  if (query?.wardId) {
    params.set("wardId", query.wardId);
  }
  if (query?.limit) {
    params.set("limit", String(query.limit));
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/admin/users/manage${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ users: ManagedUserItem[] }>(response);
  return payload.users;
}

export async function fetchAgents(token: string): Promise<AgentUserItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/agents`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ agents: AgentUserItem[] }>(response);
  return payload.agents;
}

export async function fetchVoters(token: string): Promise<VoterUserItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/voters`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ voters: VoterUserItem[] }>(response);
  return payload.voters;
}

export async function downloadSuperAdminVoterContacts(token: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/admin/voters/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    let message = "Request failed.";

    try {
      const payload = await response.json();
      message = payload.message || message;
      throw new ApiError(message, response.status, payload);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      throw new ApiError(message, response.status);
    }
  }

  return response.blob();
}

export async function createGeoPoliticalZone(token: string, body: { id: string; name: string }) {
  const response = await fetch(`${API_BASE_URL}/admin/geo-political-zones`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson(response);
}

export async function updateGeoPoliticalZone(token: string, zoneId: string, body: { name: string }) {
  const response = await fetch(`${API_BASE_URL}/admin/geo-political-zones/${zoneId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson(response);
}

export async function deleteGeoPoliticalZone(token: string, zoneId: string) {
  const response = await fetch(`${API_BASE_URL}/admin/geo-political-zones/${zoneId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  return readJson(response);
}

export async function fetchPoliticalParties(token: string): Promise<PoliticalPartyItem[]> {
  const response = await fetch(`${API_BASE_URL}/admin/political-parties`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ parties: PoliticalPartyItem[] }>(response);
  return payload.parties;
}

export async function createAdminUser(token: string, body: {
  name: string;
  email: string;
  password: string;
  adminLevel: "NATIONAL" | "GEO_POLITICAL_ZONE" | "STATE" | "SENATORIAL" | "FEDERAL_CONSTITUENCY" | "STATE_CONSTITUENCY" | "LGA" | "WARD";
  politicalPartyId?: string;
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; user: AuthUserProfile | null }>(response);
}

export async function createPoliticalParty(token: string, body: {
  id: string;
  code: string;
  name: string;
  logoUrl?: string;
  description?: string;
  officialWebsite?: string;
  isApprovedByInec?: boolean;
  inecSourceUrl?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/political-parties`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson(response);
}

export async function createCandidate(token: string, body: {
  name: string;
  email: string;
  password: string;
  officeType: "PRESIDENTIAL" | "GOVERNORSHIP" | "SENATE" | "HOUSE_OF_REP" | "STATE_ASSEMBLY" | "CHAIRMANSHIP" | "COUNCILLOR";
  politicalPartyId?: string;
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/candidates`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; user: AuthUserProfile | null }>(response);
}

export async function createAgent(token: string, body: {
  name: string;
  email: string;
  password: string;
  phone?: string;
  politicalPartyId?: string;
  stateId: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId: string;
  wardId: string;
  stateConstituencyId?: string;
  pollingUnitId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; user: AuthUserProfile | null }>(response);
}

export async function createAdminTask(token: string, body: {
  title: string;
  description: string;
  assignedToUserId: string;
  incidentId?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  dueAt?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; task: FieldTaskItem }>(response);
}

export async function createAdminBulkTasks(token: string, body: {
  title: string;
  description: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  dueAt?: string;
  agentUserIds?: string[];
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
  pollingUnitId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/tasks/bulk`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; count: number; tasks: FieldTaskItem[] }>(response);
}

export async function createAdminBroadcast(token: string, body: {
  title: string;
  message: string;
  audience: "ALL" | "ADMINS" | "AGENTS" | "VOTERS" | "CANDIDATES";
  taskStatus?: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  politicalPartyId?: string;
  adminLevel?: "NATIONAL" | "GEO_POLITICAL_ZONE" | "STATE" | "SENATORIAL" | "FEDERAL_CONSTITUENCY" | "STATE_CONSTITUENCY" | "LGA" | "WARD";
  officeType?: "PRESIDENTIAL" | "GOVERNORSHIP" | "SENATE" | "HOUSE_OF_REP" | "STATE_ASSEMBLY" | "CHAIRMANSHIP" | "COUNCILLOR";
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
  pollingUnitId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/broadcasts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; broadcast: BroadcastMessageItem }>(response);
}

export async function previewAdminBroadcast(token: string, body: {
  title: string;
  message: string;
  audience: "ALL" | "ADMINS" | "AGENTS" | "VOTERS" | "CANDIDATES";
  taskStatus?: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  politicalPartyId?: string;
  adminLevel?: "NATIONAL" | "GEO_POLITICAL_ZONE" | "STATE" | "SENATORIAL" | "FEDERAL_CONSTITUENCY" | "STATE_CONSTITUENCY" | "LGA" | "WARD";
  officeType?: "PRESIDENTIAL" | "GOVERNORSHIP" | "SENATE" | "HOUSE_OF_REP" | "STATE_ASSEMBLY" | "CHAIRMANSHIP" | "COUNCILLOR";
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
  pollingUnitId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/broadcasts/preview`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ preview: BroadcastAudiencePreview }>(response);
}

export async function createAdminEngagementTask(token: string, body: {
  title: string;
  description: string;
  type: "REGISTRATION" | "REFERRAL" | "POLL_RESPONSE";
  rewardPoints: number;
  targetCount?: number;
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
  pollingUnitId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/engagement-tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; task: VoterEngagementTaskItem }>(response);
}

export async function updateAdminTask(token: string, taskId: string, body: {
  status?: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  dueAt?: string | null;
  resolutionNote?: string | null;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; task: FieldTaskItem }>(response);
}

export async function updateAdminUser(token: string, userId: string, body: {
  name: string;
  adminLevel: "NATIONAL" | "GEO_POLITICAL_ZONE" | "STATE" | "SENATORIAL" | "FEDERAL_CONSTITUENCY" | "STATE_CONSTITUENCY" | "LGA" | "WARD";
  politicalPartyId?: string;
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; user: AuthUserProfile | null }>(response);
}

export async function updateCandidate(token: string, userId: string, body: {
  name: string;
  officeType: "PRESIDENTIAL" | "GOVERNORSHIP" | "SENATE" | "HOUSE_OF_REP" | "STATE_ASSEMBLY" | "CHAIRMANSHIP" | "COUNCILLOR";
  politicalPartyId?: string;
  geoPoliticalZoneId?: string;
  stateId?: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId?: string;
  wardId?: string;
  stateConstituencyId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/candidates/${userId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; user: AuthUserProfile | null }>(response);
}

export async function updateAgent(token: string, userId: string, body: {
  name: string;
  phone?: string;
  politicalPartyId?: string;
  stateId: string;
  senatorialDistrictId?: string;
  federalConstituencyId?: string;
  lgaId: string;
  wardId: string;
  stateConstituencyId?: string;
  pollingUnitId?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/agents/${userId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; user: AuthUserProfile | null }>(response);
}

export async function setUserActivation(
  token: string,
  userId: string,
  isActive: boolean,
): Promise<{ message: string; user: AuthUserProfile | null }> {
  const response = await fetch(`${API_BASE_URL}/admin/users/${userId}/deactivation`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ isActive }),
  });

  return readJson(response);
}

export async function updatePoliticalParty(token: string, partyId: string, body: {
  code: string;
  name: string;
  logoUrl?: string;
  description?: string;
  officialWebsite?: string;
  isApprovedByInec?: boolean;
  inecSourceUrl?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/admin/political-parties/${partyId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson(response);
}

export async function deletePoliticalParty(token: string, partyId: string) {
  const response = await fetch(`${API_BASE_URL}/admin/political-parties/${partyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  return readJson(response);
}

export async function fetchAuditLogs(
  token: string,
  query?: { actorUserId?: string; action?: string; targetType?: string; dateFrom?: string; dateTo?: string },
): Promise<AuditLogItem[]> {
  const params = new URLSearchParams();
  if (query?.actorUserId) {
    params.set("actorUserId", query.actorUserId);
  }
  if (query?.action) {
    params.set("action", query.action);
  }
  if (query?.targetType) {
    params.set("targetType", query.targetType);
  }
  if (query?.dateFrom) {
    params.set("dateFrom", query.dateFrom);
  }
  if (query?.dateTo) {
    params.set("dateTo", query.dateTo);
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/admin/audit-logs${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ auditLogs: AuditLogItem[] }>(response);
  return payload.auditLogs;
}

export async function fetchCandidatePosts(token: string): Promise<PostListItem[]> {
  const response = await fetch(`${API_BASE_URL}/candidate/posts`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ posts: PostListItem[] }>(response);
  return payload.posts;
}

export async function fetchAdminElectionDayReports(
  token: string,
  query?: { status?: "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED"; reportDate?: string },
): Promise<ElectionDayReportItem[]> {
  const params = new URLSearchParams();
  if (query?.status) {
    params.set("status", query.status);
  }
  if (query?.reportDate) {
    params.set("reportDate", query.reportDate);
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/admin/election-day-reports${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ reports: ElectionDayReportItem[] }>(response);
  return payload.reports;
}

export async function updateAdminElectionDayReportStatus(
  token: string,
  reportId: string,
  body: { status: "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED"; reviewNote?: string },
): Promise<{ message: string; report: ElectionDayReportItem }> {
  const response = await fetch(`${API_BASE_URL}/admin/election-day-reports/${reportId}/status`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; report: ElectionDayReportItem }>(response);
}

export async function fetchAdminElectionDayReportAsset(token: string, assetId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/admin/election-day-report-assets/${assetId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    let message = "Request failed.";
    try {
      const payload = await response.json();
      message = payload.message || message;
      throw new ApiError(message, response.status, payload);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(message, response.status);
    }
  }

  return response.blob();
}

function appendOptionalParam(params: URLSearchParams, key: string, value: string | undefined) {
  if (value) {
    params.set(key, value);
  }
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
}

export async function fetchEvidenceExplorer(
  token: string,
  query?: {
    search?: string;
    evidenceType?: EvidenceType;
    classification?: EvidenceClassification;
    reviewStatus?: EvidenceReviewStatus;
    pollingUnitId?: string;
    incidentId?: string;
    electionReportId?: string;
    uploaderUserId?: string;
    sha256?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): Promise<{ evidence: EvidenceAssetItem[]; summary: EvidenceExplorerSummary }> {
  const params = new URLSearchParams();
  appendOptionalParam(params, "search", query?.search);
  appendOptionalParam(params, "evidenceType", query?.evidenceType);
  appendOptionalParam(params, "classification", query?.classification);
  appendOptionalParam(params, "reviewStatus", query?.reviewStatus);
  appendOptionalParam(params, "pollingUnitId", query?.pollingUnitId);
  appendOptionalParam(params, "incidentId", query?.incidentId);
  appendOptionalParam(params, "electionReportId", query?.electionReportId);
  appendOptionalParam(params, "uploaderUserId", query?.uploaderUserId);
  appendOptionalParam(params, "sha256", query?.sha256);
  appendOptionalParam(params, "dateFrom", query?.dateFrom);
  appendOptionalParam(params, "dateTo", query?.dateTo);
  if (query?.limit) {
    params.set("limit", String(query.limit));
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/evidence${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return readJson<{ evidence: EvidenceAssetItem[]; summary: EvidenceExplorerSummary }>(response);
}

export async function fetchEvidenceAggregation(
  token: string,
  query?: {
    groupBy?: "POLLING_UNIT" | "WARD" | "STATE_CONSTITUENCY" | "FEDERAL_CONSTITUENCY" | "SENATORIAL_DISTRICT";
    evidenceType?: EvidenceType;
    classification?: EvidenceClassification;
    reviewStatus?: EvidenceReviewStatus;
    dateFrom?: string;
    dateTo?: string;
  },
): Promise<{ groupBy: string; aggregation: EvidenceAggregationItem[]; sourceLimit: number }> {
  const params = new URLSearchParams();
  appendOptionalParam(params, "groupBy", query?.groupBy);
  appendOptionalParam(params, "evidenceType", query?.evidenceType);
  appendOptionalParam(params, "classification", query?.classification);
  appendOptionalParam(params, "reviewStatus", query?.reviewStatus);
  appendOptionalParam(params, "dateFrom", query?.dateFrom);
  appendOptionalParam(params, "dateTo", query?.dateTo);

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/evidence/aggregation${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return readJson<{ groupBy: string; aggregation: EvidenceAggregationItem[]; sourceLimit: number }>(response);
}

export async function finalizeEvidenceUpload(
  token: string,
  body: {
    evidenceType: EvidenceType;
    classification: EvidenceClassification;
    file: File;
    capturedAt?: string;
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number;
    pollingUnitId?: string;
    incidentId?: string;
    electionReportId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ message: string; evidence: EvidenceAssetItem }> {
  const response = await fetch(`${API_BASE_URL}/evidence/uploads/finalize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      evidenceType: body.evidenceType,
      classification: body.classification,
      originalFileName: body.file.name,
      mimeType: body.file.type || "application/octet-stream",
      contentBase64: await fileToBase64(body.file),
      capturedAt: body.capturedAt || undefined,
      latitude: body.latitude,
      longitude: body.longitude,
      accuracyMeters: body.accuracyMeters,
      pollingUnitId: body.pollingUnitId || undefined,
      incidentId: body.incidentId || undefined,
      electionReportId: body.electionReportId || undefined,
      metadata: body.metadata,
    }),
  });

  return readJson<{ message: string; evidence: EvidenceAssetItem }>(response);
}

export async function updateEvidenceReview(
  token: string,
  evidenceAssetId: string,
  body: { status: EvidenceReviewStatus; classification?: EvidenceClassification; note?: string },
): Promise<{ message: string; evidence: EvidenceAssetItem }> {
  const response = await fetch(`${API_BASE_URL}/evidence/${evidenceAssetId}/review`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; evidence: EvidenceAssetItem }>(response);
}

export async function createEvidenceAccess(
  token: string,
  evidenceAssetId: string,
  body: { action: "VIEW" | "DOWNLOAD"; expiresInSeconds?: number },
): Promise<{ access: { signedUrl: string; expiresAt: string; publicUrl: null; storageKey: string } }> {
  const response = await fetch(`${API_BASE_URL}/evidence/${evidenceAssetId}/access`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ access: { signedUrl: string; expiresAt: string; publicUrl: null; storageKey: string } }>(response);
}

export async function fetchEvidenceTimeline(token: string, pollingUnitId: string): Promise<EvidenceTimelineItem[]> {
  const response = await fetch(`${API_BASE_URL}/evidence/polling-units/${encodeURIComponent(pollingUnitId)}/timeline`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ pollingUnitId: string; timeline: EvidenceTimelineItem[] }>(response);
  return payload.timeline;
}

export async function fetchEvidenceDossier(token: string, pollingUnitId: string): Promise<EvidenceDossier> {
  const response = await fetch(`${API_BASE_URL}/evidence/polling-units/${encodeURIComponent(pollingUnitId)}/dossier`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ dossier: EvidenceDossier }>(response);
  return payload.dossier;
}

export async function fetchLegalCases(token: string): Promise<LegalCaseItem[]> {
  const response = await fetch(`${API_BASE_URL}/evidence/legal-cases`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ legalCases: LegalCaseItem[] }>(response);
  return payload.legalCases;
}

export async function createLegalCase(
  token: string,
  body: { title: string; description?: string; pollingUnitId?: string; evidenceAssetIds?: string[]; note?: string },
): Promise<{ legalCase: LegalCaseItem; noLegalConclusion: boolean }> {
  const response = await fetch(`${API_BASE_URL}/evidence/legal-cases`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, evidenceAssetIds: body.evidenceAssetIds || [] }),
  });

  return readJson<{ legalCase: LegalCaseItem; noLegalConclusion: boolean }>(response);
}

export async function createEvidenceManifestExport(
  token: string,
  body: { evidenceAssetIds: string[]; legalCaseId?: string; purpose: string },
): Promise<{ evidencePackage: EvidencePackageItem; manifest: EvidenceManifest }> {
  const response = await fetch(`${API_BASE_URL}/evidence/exports/manifest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ evidencePackage: EvidencePackageItem; manifest: EvidenceManifest }>(response);
}

export async function verifyEvidenceManifest(
  token: string,
  body: { manifest: EvidenceManifest; manifestSha256: string },
): Promise<{ verified: boolean; computedSha256: string; suppliedSha256: string }> {
  const response = await fetch(`${API_BASE_URL}/evidence/exports/verify-manifest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ verified: boolean; computedSha256: string; suppliedSha256: string }>(response);
}

export async function fetchCandidateProfileEditor(token: string): Promise<CandidateProfileEditorItem> {
  const response = await fetch(`${API_BASE_URL}/candidate/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ profile: CandidateProfileEditorItem }>(response);
  return payload.profile;
}

export async function updateCandidateProfile(
  token: string,
  body: {
    portraitAssetId?: string;
    portraitUrl?: string;
    campaignSlogan?: string;
    bio?: string;
    websiteUrl?: string;
    facebookUrl?: string;
    instagramUrl?: string;
    xUrl?: string;
    isProfilePublished: boolean;
  },
) {
  const response = await fetch(`${API_BASE_URL}/candidate/profile`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; profile: CandidateProfileEditorItem }>(response);
}

export async function uploadCandidateImage(
  token: string,
  kind: "profile-photo" | "event-cover",
  file: File,
): Promise<{ message: string; asset: { id: string; fileName: string; fileUrl: string | null } }> {
  const response = await fetch(`${API_BASE_URL}/candidate/assets/${kind}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": file.type,
      "X-File-Name": file.name,
    },
    body: file,
  });

  return readJson<{ message: string; asset: { id: string; fileName: string; fileUrl: string | null } }>(response);
}

export async function deleteManagedUser(
  token: string,
  userId: string,
): Promise<{ message: string; dependencyCounts?: Record<string, number> }> {
  const response = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  return readJson<{ message: string; dependencyCounts?: Record<string, number> }>(response);
}

export async function revokeAgentSession(
  token: string,
  userId: string,
): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}/admin/agents/${userId}/revoke-session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  return readJson<{ message: string }>(response);
}

export async function fetchCandidateVoters(token: string): Promise<CandidateVoterItem[]> {
  const response = await fetch(`${API_BASE_URL}/candidate/voters`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ voters: CandidateVoterItem[] }>(response);
  return payload.voters;
}

export async function fetchCandidateBroadcasts(token: string): Promise<BroadcastMessageItem[]> {
  const response = await fetch(`${API_BASE_URL}/candidate/broadcasts`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ broadcasts: BroadcastMessageItem[] }>(response);
  return payload.broadcasts;
}

export async function fetchCandidateEvents(token: string): Promise<CampaignEventItem[]> {
  const response = await fetch(`${API_BASE_URL}/candidate/events`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ events: CampaignEventItem[] }>(response);
  return payload.events;
}

export async function createCandidateBroadcast(
  token: string,
  body: { title: string; message: string },
): Promise<{ message: string; broadcast: BroadcastMessageItem }> {
  const response = await fetch(`${API_BASE_URL}/candidate/broadcasts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; broadcast: BroadcastMessageItem }>(response);
}

export async function createCandidatePost(
  token: string,
  body: {
    title: string;
    content: string;
    mediaType?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
    mediaUrl?: string;
    thumbnailUrl?: string;
    isPublished?: boolean;
    audience?: "VOTERS" | "AGENTS" | "ALL";
  },
): Promise<{ message: string; post: PostListItem }> {
  const response = await fetch(`${API_BASE_URL}/candidate/posts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; post: PostListItem }>(response);
}

export async function createCandidateEvent(
  token: string,
  body: {
    title: string;
    description: string;
    venue: string;
    coverImageAssetId?: string;
    stateId?: string;
    lgaId?: string;
    wardId?: string;
    pollingUnitId?: string;
    startsAt: string;
    endsAt?: string;
    isPublished?: boolean;
  },
) {
  const response = await fetch(`${API_BASE_URL}/candidate/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; event: CampaignEventItem }>(response);
}

export async function updateCandidateEvent(
  token: string,
  eventId: string,
  body: {
    title?: string;
    description?: string;
    venue?: string;
    coverImageAssetId?: string;
    stateId?: string;
    lgaId?: string;
    wardId?: string;
    pollingUnitId?: string;
    startsAt?: string;
    endsAt?: string | null;
    isPublished?: boolean;
  },
) {
  const response = await fetch(`${API_BASE_URL}/candidate/events/${eventId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; event: CampaignEventItem }>(response);
}

export async function deleteCandidateEvent(token: string, eventId: string) {
  const response = await fetch(`${API_BASE_URL}/candidate/events/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  return readJson<{ message: string }>(response);
}

export async function updateCandidatePost(
  token: string,
  postId: string,
  body: {
    title?: string;
    content?: string;
    mediaType?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
    mediaUrl?: string;
    thumbnailUrl?: string;
    isPublished?: boolean;
  },
) {
  const response = await fetch(`${API_BASE_URL}/candidate/posts/${postId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; post: PostListItem }>(response);
}

export async function deleteCandidatePost(token: string, postId: string) {
  const response = await fetch(`${API_BASE_URL}/candidate/posts/${postId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  return readJson<{ message: string }>(response);
}

export async function fetchCandidateFeedback(
  token: string,
): Promise<{ totalFeedback: number; feedback: FeedbackListItem[] }> {
  const response = await fetch(`${API_BASE_URL}/candidate/feedback`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return readJson(response);
}

export async function fetchCandidateIncidents(
  token: string,
): Promise<{ totalIncidents: number; incidents: IncidentListItem[] }> {
  const response = await fetch(`${API_BASE_URL}/candidate/incidents`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return readJson<{ totalIncidents: number; incidents: IncidentListItem[] }>(response);
}

export async function fetchCandidateAgentActivitySummaries(token: string): Promise<AgentActivitySummary[]> {
  const response = await fetch(`${API_BASE_URL}/candidate/agent-activity-summaries`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ agentActivitySummaries: AgentActivitySummary[] }>(response);
  return payload.agentActivitySummaries;
}

export async function fetchCandidateMapSummary(token: string): Promise<AdminMapSummary> {
  const response = await fetch(`${API_BASE_URL}/candidate/map-summary`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ mapSummary: AdminMapSummary }>(response);
  return payload.mapSummary;
}

export async function fetchElectionDaySituationRoomStatus(token: string, reportDate?: string): Promise<ElectionDaySituationRoomStatus> {
  const query = reportDate ? `?reportDate=${encodeURIComponent(reportDate)}` : "";
  const response = await fetch(`${API_BASE_URL}/election-day/situation-room/status${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ status: ElectionDaySituationRoomStatus }>(response);
  return payload.status;
}

export async function reconcileElectionDayAlerts(
  token: string,
  body?: { reportDate?: string },
): Promise<{ message: string; alerts: ElectionDayOperationalAlertItem[] }> {
  const response = await fetch(`${API_BASE_URL}/election-day/alerts/reconcile`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  return readJson<{ message: string; alerts: ElectionDayOperationalAlertItem[] }>(response);
}

export async function fetchElectionDayAlerts(
  token: string,
  query?: { status?: "OPEN" | "ACKNOWLEDGED" | "ESCALATED" | "RESOLVED"; type?: string; reportDate?: string },
): Promise<ElectionDayOperationalAlertItem[]> {
  const params = new URLSearchParams();
  if (query?.status) {
    params.set("status", query.status);
  }
  if (query?.type) {
    params.set("type", query.type);
  }
  if (query?.reportDate) {
    params.set("reportDate", query.reportDate);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/election-day/alerts${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ alerts: ElectionDayOperationalAlertItem[] }>(response);
  return payload.alerts;
}

export async function updateElectionDayAlert(
  token: string,
  alertId: string,
  body: { status: "ACKNOWLEDGED" | "ESCALATED" | "RESOLVED"; note?: string },
): Promise<{ message: string; alert: ElectionDayOperationalAlertItem }> {
  const response = await fetch(`${API_BASE_URL}/election-day/alerts/${encodeURIComponent(alertId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; alert: ElectionDayOperationalAlertItem }>(response);
}

export async function fetchElectionDayTimeline(token: string, query?: { reportDate?: string; limit?: number }): Promise<ElectionDayTimelineItem[]> {
  const params = new URLSearchParams();
  if (query?.reportDate) {
    params.set("reportDate", query.reportDate);
  }
  if (query?.limit) {
    params.set("limit", String(query.limit));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/election-day/timeline${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ timeline: ElectionDayTimelineItem[] }>(response);
  return payload.timeline;
}

export async function fetchElectionDayConversations(token: string): Promise<ElectionDayConversationItem[]> {
  const response = await fetch(`${API_BASE_URL}/election-day/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ conversations: ElectionDayConversationItem[] }>(response);
  return payload.conversations;
}

export async function createElectionDayConversation(
  token: string,
  body: {
    type: "DIRECT" | "GROUP" | "TERRITORY" | "ELECTION_OPERATION";
    title?: string;
    recipientUserId?: string;
    memberUserIds?: string[];
    territory?: {
      stateId?: string;
      senatorialDistrictId?: string | null;
      federalConstituencyId?: string | null;
      stateConstituencyId?: string | null;
      wardId?: string | null;
      pollingUnitId?: string | null;
    };
  },
): Promise<{ message: string; conversationId: string }> {
  const response = await fetch(`${API_BASE_URL}/election-day/conversations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; conversationId: string }>(response);
}

export async function fetchElectionDayMessages(token: string, conversationId: string): Promise<ElectionDayMessageItem[]> {
  const response = await fetch(`${API_BASE_URL}/election-day/conversations/${encodeURIComponent(conversationId)}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ messages: ElectionDayMessageItem[] }>(response);
  return payload.messages;
}

export async function createElectionDayMessage(
  token: string,
  conversationId: string,
  body: { body: string; metadata?: Record<string, unknown> },
): Promise<{ message: string; item: ElectionDayMessageItem }> {
  const response = await fetch(`${API_BASE_URL}/election-day/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return readJson<{ message: string; item: ElectionDayMessageItem }>(response);
}

export async function fetchElectionDayPresence(token: string, userIds: string[]): Promise<RealtimePresenceEntry[]> {
  if (userIds.length === 0) {
    return [];
  }
  const response = await fetch(`${API_BASE_URL}/election-day/presence?userIds=${encodeURIComponent(userIds.join(","))}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ presence: RealtimePresenceEntry[] }>(response);
  return payload.presence;
}

export async function fetchElectionDayWebrtcConfig(token: string): Promise<ElectionDayWebrtcConfig> {
  const response = await fetch(`${API_BASE_URL}/election-day/webrtc/config`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ config: ElectionDayWebrtcConfig }>(response);
  return payload.config;
}

export async function initiateElectionDayCall(
  token: string,
  body: { targetUserId: string; conversationId?: string },
): Promise<ElectionDayCallItem> {
  const response = await fetch(`${API_BASE_URL}/election-day/calls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson<{ item: ElectionDayCallItem }>(response);
  return payload.item;
}

export async function acceptElectionDayCall(token: string, callId: string): Promise<ElectionDayCallItem> {
  const response = await fetch(`${API_BASE_URL}/election-day/calls/${callId}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await readJson<{ item: ElectionDayCallItem }>(response);
  return payload.item;
}

export async function rejectElectionDayCall(token: string, callId: string): Promise<ElectionDayCallItem> {
  const response = await fetch(`${API_BASE_URL}/election-day/calls/${callId}/reject`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await readJson<{ item: ElectionDayCallItem }>(response);
  return payload.item;
}

export async function endElectionDayCall(
  token: string,
  callId: string,
  reason?: "COMPLETED" | "CANCELLED" | "FAILED",
): Promise<ElectionDayCallItem> {
  const response = await fetch(`${API_BASE_URL}/election-day/calls/${callId}/end`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  const payload = await readJson<{ item: ElectionDayCallItem }>(response);
  return payload.item;
}

/** Relays a WebRTC offer/answer/ICE candidate to the peer. Signal bodies are never persisted. */
export async function sendElectionDayCallSignal(
  token: string,
  callId: string,
  body: { signalType: VoiceCallSignalType; targetUserId: string; signal: unknown },
): Promise<{ delivered: boolean; transport: string }> {
  const response = await fetch(`${API_BASE_URL}/election-day/calls/${callId}/signal`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<{ delivered: boolean; transport: string }>(response);
}

export async function fetchElectionDayCalls(
  token: string,
  query?: { status?: VoiceCallStatus; limit?: number },
): Promise<ElectionDayCallItem[]> {
  const search = new URLSearchParams();
  if (query?.status) {
    search.set("status", query.status);
  }
  if (query?.limit) {
    search.set("limit", String(query.limit));
  }
  const suffix = search.toString() ? `?${search.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/election-day/calls${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ calls: ElectionDayCallItem[] }>(response);
  return payload.calls;
}

export async function fetchElectionDayCall(token: string, callId: string): Promise<ElectionDayCallItem> {
  const response = await fetch(`${API_BASE_URL}/election-day/calls/${callId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ item: ElectionDayCallItem }>(response);
  return payload.item;
}

export async function fetchNotifications(token: string): Promise<NotificationItem[]> {
  const response = await fetch(`${API_BASE_URL}/notifications`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ notifications: NotificationItem[] }>(response);
  return payload.notifications;
}

export async function markAllNotificationsRead(token: string) {
  const response = await fetch(`${API_BASE_URL}/notifications/read-all`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  });

  return readJson(response);
}

export async function fetchVoterPolls(token: string): Promise<PollListItem[]> {
  const response = await fetch(`${API_BASE_URL}/voter/polls`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ polls: PollListItem[] }>(response);
  return payload.polls;
}

export async function fetchVoterPosts(token: string): Promise<PostListItem[]> {
  const response = await fetch(`${API_BASE_URL}/voter/posts`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ posts: PostListItem[] }>(response);
  return payload.posts;
}

export async function fetchVoterEvents(token: string): Promise<CampaignEventItem[]> {
  const response = await fetch(`${API_BASE_URL}/voter/events`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ events: CampaignEventItem[] }>(response);
  return payload.events;
}

export async function fetchPublicCandidates(query?: {
  search?: string;
  stateId?: string;
  partyId?: string;
  officeType?: "PRESIDENTIAL" | "GOVERNORSHIP" | "SENATE" | "HOUSE_OF_REP" | "STATE_ASSEMBLY" | "CHAIRMANSHIP" | "COUNCILLOR";
}): Promise<CandidatePublicListItem[]> {
  const params = new URLSearchParams();
  if (query?.search) {
    params.set("search", query.search);
  }
  if (query?.stateId) {
    params.set("stateId", query.stateId);
  }
  if (query?.partyId) {
    params.set("partyId", query.partyId);
  }
  if (query?.officeType) {
    params.set("officeType", query.officeType);
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/candidate/public${suffix}`, {
    cache: "no-store",
  });

  const payload = await readJson<{ candidates: CandidatePublicListItem[] }>(response);
  return payload.candidates;
}

export async function fetchPublicCandidateProfile(candidateUserId: string): Promise<CandidatePublicProfile> {
  const response = await fetch(`${API_BASE_URL}/candidate/public/${candidateUserId}`, {
    cache: "no-store",
  });

  const payload = await readJson<{ candidate: CandidatePublicProfile }>(response);
  return payload.candidate;
}

export async function fetchPublicParties(query?: { search?: string }): Promise<PoliticalPartyItem[]> {
  const params = new URLSearchParams();
  if (query?.search) {
    params.set("search", query.search);
  }

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${API_BASE_URL}/candidate/public/parties${suffix}`, {
    cache: "no-store",
  });

  const payload = await readJson<{ parties: PoliticalPartyItem[] }>(response);
  return payload.parties;
}

export async function fetchPublicPartyProfile(partyId: string): Promise<PoliticalPartyPublicProfile> {
  const response = await fetch(`${API_BASE_URL}/candidate/public/parties/${partyId}`, {
    cache: "no-store",
  });

  const payload = await readJson<{ party: PoliticalPartyPublicProfile }>(response);
  return payload.party;
}

export async function fetchVoterEngagementTasks(token: string): Promise<VoterEngagementTaskItem[]> {
  const response = await fetch(`${API_BASE_URL}/voter/engagement-tasks`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ tasks: VoterEngagementTaskItem[] }>(response);
  return payload.tasks;
}

export async function rsvpToCampaignEvent(
  token: string,
  eventId: string,
  body: { status: "INTERESTED" | "GOING" },
) {
  const response = await fetch(`${API_BASE_URL}/voter/events/${eventId}/rsvp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; event: CampaignEventItem | null }>(response);
}

export async function claimVoterEngagementTask(token: string, taskId: string) {
  const response = await fetch(`${API_BASE_URL}/voter/engagement-tasks/${taskId}/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  return readJson<{ message: string }>(response);
}

export async function fetchVoterRedemptions(
  token: string,
): Promise<{ balance: RewardBalanceSummary; redemptions: RewardRedemptionItem[] }> {
  const response = await fetch(`${API_BASE_URL}/voter/redemptions`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return readJson(response);
}

export async function createVoterRedemption(
  token: string,
  body: { pointsRequested: number; note?: string },
) {
  const response = await fetch(`${API_BASE_URL}/voter/redemptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson(response);
}

export async function fetchAgentActivities(token: string): Promise<Array<{
  id: string;
  type: string;
  note: string | null;
  createdAt: string;
  latitude: number | null;
  longitude: number | null;
  pollingUnitId: string | null;
}>> {
  const response = await fetch(`${API_BASE_URL}/agent/activities`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ activities: Array<{
    id: string;
    type: string;
    note: string | null;
    createdAt: string;
    latitude: number | null;
    longitude: number | null;
    pollingUnitId: string | null;
  }> }>(response);
  return payload.activities;
}

export async function fetchAgentTasks(token: string): Promise<FieldTaskItem[]> {
  const response = await fetch(`${API_BASE_URL}/agent/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ tasks: FieldTaskItem[] }>(response);
  return payload.tasks;
}

export async function fetchAgentElectionDayReports(token: string): Promise<ElectionDayReportItem[]> {
  const response = await fetch(`${API_BASE_URL}/agent/election-reports`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await readJson<{ reports: ElectionDayReportItem[] }>(response);
  return payload.reports;
}

export async function uploadAgentElectionReportPhoto(
  token: string,
  kind: "arrival-photo" | "post-counting-photo",
  file: File,
): Promise<{ message: string; asset: ElectionDayReportAssetItem }> {
  const response = await fetch(`${API_BASE_URL}/agent/election-report-assets/${kind}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": file.type,
      "X-File-Name": file.name,
    },
    body: file,
  });

  return readJson<{ message: string; asset: ElectionDayReportAssetItem }>(response);
}

export async function createAgentElectionDayReport(
  token: string,
  body: {
    reportDate: string;
    openingStatus: "OPENED_ON_TIME" | "OPENED_LATE" | "NOT_OPEN";
    arrivalConfirmedAt: string;
    turnoutObservation: string;
    incidentNotes?: string;
    remarks?: string;
    arrivalPhotoAssetId: string;
    postCountingPhotoAssetId: string;
    voteEntries: Array<{ politicalPartyId: string; votes: number }>;
  },
): Promise<{ message: string; report: ElectionDayReportItem }> {
  const response = await fetch(`${API_BASE_URL}/agent/election-reports`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; report: ElectionDayReportItem }>(response);
}

export async function fetchAgentElectionDayReportAsset(token: string, assetId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/agent/election-report-assets/${assetId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    let message = "Request failed.";
    try {
      const payload = await response.json();
      message = payload.message || message;
      throw new ApiError(message, response.status, payload);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError(message, response.status);
    }
  }

  return response.blob();
}

export async function createAgentActivity(
  token: string,
  path: "check-in" | "check-out" | "location",
  body: {
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number;
    note?: string;
    pollingUnitId?: string;
  },
) {
  const response = await fetch(`${API_BASE_URL}/agent/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson(response);
}

export async function createAgentIncident(
  token: string,
  body: {
    type: string;
    title: string;
    description: string;
    severity: string;
    pollingUnitId?: string;
    latitude?: number;
    longitude?: number;
  },
) {
  const response = await fetch(`${API_BASE_URL}/agent/incidents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson(response);
}

export async function updateAgentTask(token: string, taskId: string, body: {
  status: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  resolutionNote?: string;
}) {
  const response = await fetch(`${API_BASE_URL}/agent/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return readJson<{ message: string; task: FieldTaskItem }>(response);
}

export async function fetchHierarchicalDashboard(
  token: string,
  query?: { level?: DashboardLevel; territoryId?: string; leaderboardMetric?: LeaderboardMetric; leaderboardLimit?: number },
): Promise<HierarchicalDashboard> {
  const search = new URLSearchParams();
  if (query?.level) search.set("level", query.level);
  if (query?.territoryId) search.set("territoryId", query.territoryId);
  if (query?.leaderboardMetric) search.set("leaderboardMetric", query.leaderboardMetric);
  if (query?.leaderboardLimit) search.set("leaderboardLimit", String(query.leaderboardLimit));
  const suffix = search.toString() ? `?${search.toString()}` : "";

  const response = await fetch(`${API_BASE_URL}/dashboard${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await readJson<{ dashboard: HierarchicalDashboard }>(response);
  return payload.dashboard;
}
