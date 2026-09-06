"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { OGUN_STATE_ID, type AuthUserProfile } from "@pics-nigeria/shared";
import { AdminNav } from "../../../components/admin-nav";
import { PaymentReferenceDialog } from "../../../components/payment-reference-dialog";
import {
  DataTable,
  EmptyRow,
  Field,
  Kpi,
  KpiRow,
  Money,
  Notice,
  PageHead,
  Panel,
  PanelGrid,
  StateView,
  StatusPill,
  Toolbar,
  ToolbarEnd,
  ToolbarField,
  formatCount,
  formatMoney,
} from "../../../components/ui";
import { describeApiError, type DescribedError } from "../../../lib/api-errors";
import {
  ApiError,
  accessPreElectionVerificationDocument,
  approvePreElectionPayoutBatch,
  calculatePreElectionStrengthSnapshot,
  claimPreElectionVerification,
  createPreElectionPayoutBatch,
  createPreElectionPayoutConfiguration,
  createPreElectionPayoutCycle,
  createPreElectionRewardRule,
  createPreElectionStrengthMetric,
  createPreElectionStrengthWeight,
  createPreElectionTerritoryTarget,
  decidePreElectionVerification,
  exportPreElectionVerificationsCsv,
  fetchCurrentUser,
  fetchPreElectionPayoutAssignments,
  fetchPreElectionPayoutBatches,
  fetchPreElectionPayoutCycles,
  fetchPreElectionPayoutEligibility,
  fetchPreElectionPayoutOfficers,
  fetchPreElectionReferrals,
  fetchPreElectionRewardRules,
  fetchPreElectionStrengthDashboard,
  fetchPreElectionVerifications,
  updatePreElectionPayoutAssignment,
  type PreElectionPayoutAssignment,
  type PreElectionPayoutBatch,
  type PreElectionReferralItem,
  type PreElectionStrengthDashboard,
  type PreElectionVerificationCase,
} from "../../../lib/api";
import { readSession } from "../../../lib/session";

const verificationStatuses = ["PENDING", "UNDER_REVIEW", "RESUBMISSION_REQUIRED", "VERIFIED", "REJECTED"];
const referralStatuses = ["PENDING_VERIFICATION", "QUALIFIED", "REJECTED", "FLAGGED", "REWARD_PROCESSED"];
const payoutStatuses = ["ELIGIBLE", "APPROVED", "PROCESSING", "PAID", "HELD", "REJECTED"];
const territoryTypes = ["STATE", "SENATORIAL_DISTRICT", "FEDERAL_CONSTITUENCY", "STATE_CONSTITUENCY", "WARD", "POLLING_UNIT"];

function defaultTerritory(user: AuthUserProfile | null) {
  const profile = user?.coordinatorProfile || user?.adminProfile;
  if (profile?.pollingUnitId) return { territoryType: "POLLING_UNIT", territoryId: profile.pollingUnitId };
  if (profile?.wardId) return { territoryType: "WARD", territoryId: profile.wardId };
  if (profile?.stateConstituencyId) return { territoryType: "STATE_CONSTITUENCY", territoryId: profile.stateConstituencyId };
  if (profile?.federalConstituencyId) return { territoryType: "FEDERAL_CONSTITUENCY", territoryId: profile.federalConstituencyId };
  if (profile?.senatorialDistrictId) return { territoryType: "SENATORIAL_DISTRICT", territoryId: profile.senatorialDistrictId };
  return { territoryType: "STATE", territoryId: OGUN_STATE_ID };
}

function canUseAdminWorkspace(user: AuthUserProfile | null) {
  return Boolean(user && ["SUPER_ADMIN", "STATE_OFFICER", "COORDINATOR", "VALIDATOR", "PAYOUT_OFFICER", "ADMIN"].includes(user.role));
}

export default function AdminPreElectionPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [verifications, setVerifications] = useState<PreElectionVerificationCase[]>([]);
  const [referrals, setReferrals] = useState<PreElectionReferralItem[]>([]);
  const [referralSummary, setReferralSummary] = useState<Record<string, number>>({});
  const [rewardRules, setRewardRules] = useState<Array<{ id: string; name: string; eligibleRole: string; eligibleCoordinatorLevel: string | null; versions: Array<{ version: number; directPoints: number }> }>>([]);
  const [payoutBatches, setPayoutBatches] = useState<PreElectionPayoutBatch[]>([]);
  const [payoutAssignments, setPayoutAssignments] = useState<PreElectionPayoutAssignment[]>([]);
  const [payoutCycles, setPayoutCycles] = useState<Array<{ id: string; name: string; status: string; payoutDate: string; minimumThreshold: number; conversionRate: string }>>([]);
  const [payoutOfficers, setPayoutOfficers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [payoutEligibility, setPayoutEligibility] = useState<Array<{ userId: string; name: string | null; email: string | null; availablePoints: number; amount: string }>>([]);
  const [strengthDashboard, setStrengthDashboard] = useState<PreElectionStrengthDashboard | null>(null);
  const [verificationFilter, setVerificationFilter] = useState({ status: "PENDING", search: "" });
  const [referralFilter, setReferralFilter] = useState({ status: "", search: "" });
  const [payoutStatus, setPayoutStatus] = useState("");
  const [territory, setTerritory] = useState({ territoryType: "STATE", territoryId: OGUN_STATE_ID });
  const [decisionNoteById, setDecisionNoteById] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [rewardRuleForm, setRewardRuleForm] = useState({ name: "Verified referral coordinator rule", directPoints: "25", eligibleCoordinatorLevel: "" });
  const [payoutConfigForm, setPayoutConfigForm] = useState({ minimumPoints: "25", pointConversionRate: "1", frequency: "WEEKLY" });
  const [payoutCycleForm, setPayoutCycleForm] = useState({ name: "Weekly Pre-Election Cycle", opensAt: "", closesAt: "", payoutDate: "" });
  const [payoutBatchForm, setPayoutBatchForm] = useState({ cycleId: "", payoutOfficerUserId: "" });
  const [targetForm, setTargetForm] = useState({ metric: "VERIFIED_MEMBERS", targetValue: "100" });
  const [payoutBusy, setPayoutBusy] = useState<string | null>(null);
  const [payingAssignment, setPayingAssignment] = useState<PreElectionPayoutAssignment | null>(null);
  const [payoutProblem, setPayoutProblem] = useState<DescribedError | null>(null);
  const [payoutMessage, setPayoutMessage] = useState<string | null>(null);
  /**
   * Learned from the first refusal rather than guessed: the API reports the
   * kill switch inside its 409 body. Once we have seen it, the pay buttons
   * disable themselves so the operator is not invited to try again.
   */
  const [payoutExecutionEnabled, setPayoutExecutionEnabled] = useState<boolean | null>(null);

  const token = typeof window === "undefined" ? null : readSession();

  /**
   * Every payout mutation goes through here. Before this, four of them were
   * `fn(...).then(() => reload())` with no .catch at all — and because payout
   * execution is disabled by default in every environment, the default
   * experience of the primary money button was that nothing happened and
   * nothing was said.
   */
  async function runPayout(key: string, action: (activeToken: string) => Promise<string>) {
    if (!token) return;
    setPayoutBusy(key);
    setPayoutProblem(null);
    setPayoutMessage(null);
    try {
      const note = await action(token);
      setPayoutMessage(note);
      setPayoutExecutionEnabled(true);
      await reload();
    } catch (caught) {
      const described = describeApiError(caught);
      setPayoutProblem(described);
      if (described.code === "PAYOUT_EXECUTION_DISABLED") {
        setPayoutExecutionEnabled(false);
      }
    } finally {
      setPayoutBusy(null);
    }
  }
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const isValidator = user?.role === "VALIDATOR";
  const isPayoutOfficer = user?.role === "PAYOUT_OFFICER";
  const canViewStrength = Boolean(user && ["SUPER_ADMIN", "STATE_OFFICER", "COORDINATOR", "ADMIN"].includes(user.role));

  async function loadPage(authToken: string, currentUser?: AuthUserProfile) {
    const loadedUser = currentUser || (await fetchCurrentUser(authToken));
    if (!canUseAdminWorkspace(loadedUser)) {
      throw new ApiError("This workspace is restricted to pre-election operators.", 403);
    }
    const nextTerritory = territory.territoryId ? territory : defaultTerritory(loadedUser);
    setUser(loadedUser);
    setTerritory(nextTerritory);

    if (loadedUser.role === "VALIDATOR" || loadedUser.role === "SUPER_ADMIN") {
      setVerifications(await fetchPreElectionVerifications(authToken, {
        status: verificationFilter.status || undefined,
        search: verificationFilter.search || undefined,
      }));
    }
    if (["SUPER_ADMIN", "STATE_OFFICER", "COORDINATOR", "ADMIN"].includes(loadedUser.role)) {
      const referralData = await fetchPreElectionReferrals(authToken, {
        territoryType: nextTerritory.territoryType,
        territoryId: nextTerritory.territoryId,
        status: referralFilter.status || undefined,
        search: referralFilter.search || undefined,
      });
      setReferrals(referralData.referrals);
      setReferralSummary(referralData.summary);
      setStrengthDashboard(await fetchPreElectionStrengthDashboard(authToken, nextTerritory));
    }
    if (loadedUser.role === "SUPER_ADMIN") {
      const [rules, cycles, officers, batches, eligibility] = await Promise.all([
        fetchPreElectionRewardRules(authToken),
        fetchPreElectionPayoutCycles(authToken),
        fetchPreElectionPayoutOfficers(authToken),
        fetchPreElectionPayoutBatches(authToken, payoutStatus || undefined),
        fetchPreElectionPayoutEligibility(authToken).catch(() => ({ payoutEligibility: [] })),
      ]);
      setRewardRules(rules.rewardRules);
      setPayoutCycles(cycles.payoutCycles);
      setPayoutOfficers(officers);
      setPayoutBatches(batches);
      setPayoutEligibility(eligibility.payoutEligibility);
    }
    if (loadedUser.role === "PAYOUT_OFFICER") {
      const [cycles, batches, assignments] = await Promise.all([
        fetchPreElectionPayoutCycles(authToken),
        fetchPreElectionPayoutBatches(authToken, payoutStatus || undefined),
        fetchPreElectionPayoutAssignments(authToken, payoutStatus || undefined),
      ]);
      setPayoutCycles(cycles.payoutCycles);
      setPayoutBatches(batches);
      setPayoutAssignments(assignments);
    }
  }

  useEffect(() => {
    const authToken = readSession();
    if (!authToken) {
      window.location.href = "/login";
      return;
    }
    loadPage(authToken)
      .catch((caughtError) => setError(caughtError instanceof Error ? caughtError.message : "Could not load pre-election workspace."))
      .finally(() => setLoading(false));
  }, []);

  const verificationCounts = useMemo(
    () => verifications.reduce<Record<string, number>>((accumulator, item) => {
      accumulator[item.status] = (accumulator[item.status] || 0) + 1;
      return accumulator;
    }, {}),
    [verifications],
  );

  async function reload() {
    if (!token) return;
    setMessage("");
    setError("");
    try {
      await loadPage(token, user || undefined);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Refresh failed.");
    }
  }

  async function handleVerificationDecision(verificationId: string, decision: "APPROVE" | "REJECT" | "REQUEST_RESUBMISSION") {
    if (!token) return;
    try {
      await decidePreElectionVerification(token, verificationId, { decision, note: decisionNoteById[verificationId] || undefined });
      setMessage(`Verification ${decision.toLowerCase().replace("_", " ")} recorded.`);
      await reload();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Decision failed.");
    }
  }

  async function handleRewardRuleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    await createPreElectionRewardRule(token, {
      name: rewardRuleForm.name,
      directPoints: Number(rewardRuleForm.directPoints),
      eligibleRole: "COORDINATOR",
      eligibleCoordinatorLevel: rewardRuleForm.eligibleCoordinatorLevel || undefined,
    });
    setMessage("Reward rule created.");
    await reload();
  }

  async function handlePayoutConfigSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    await createPreElectionPayoutConfiguration(token, {
      minimumPoints: Number(payoutConfigForm.minimumPoints),
      pointConversionRate: Number(payoutConfigForm.pointConversionRate),
      frequency: payoutConfigForm.frequency,
    });
    setMessage("Payout configuration saved.");
    await reload();
  }

  async function handlePayoutCycleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    await createPreElectionPayoutCycle(token, {
      name: payoutCycleForm.name,
      opensAt: new Date(payoutCycleForm.opensAt).toISOString(),
      closesAt: new Date(payoutCycleForm.closesAt).toISOString(),
      payoutDate: new Date(payoutCycleForm.payoutDate).toISOString(),
    });
    setMessage("Payout cycle created.");
    await reload();
  }

  async function handlePayoutBatchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    await createPreElectionPayoutBatch(token, payoutBatchForm.cycleId, {
      payoutOfficerUserId: payoutBatchForm.payoutOfficerUserId,
      beneficiaryUserIds: payoutEligibility.map((item) => item.userId),
    });
    setMessage("Payout batch created from eligible beneficiaries.");
    await reload();
  }

  async function handleStrengthConfigure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    await createPreElectionStrengthMetric(token, { metric: targetForm.metric, description: `${targetForm.metric} campaign strength metric` }).catch(() => undefined);
    await createPreElectionStrengthWeight(token, { metric: targetForm.metric, weight: 1 }).catch(() => undefined);
    await createPreElectionTerritoryTarget(token, {
      territoryType: territory.territoryType,
      territoryId: territory.territoryId,
      metric: targetForm.metric,
      targetValue: Number(targetForm.targetValue),
      startDate: new Date().toISOString(),
    });
    await calculatePreElectionStrengthSnapshot(token, territory);
    setMessage("Strength target and snapshot updated.");
    await reload();
  }

  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Pre-election operations" />
        <StateView kind="loading" title="Loading pre-election workspace…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Pre-election operations" />
        <StateView
          kind="error"
          title="Unable to load the pre-election workspace"
          detail={error || "Authentication is required."}
          action={
            <Link className="btn btn-primary" href="/login">
              Return to sign in
            </Link>
          }
        />
      </main>
    );
  }

  const assignmentRows = (isPayoutOfficer ? payoutAssignments : payoutBatches.flatMap((batch) => batch.assignments)).slice(0, 50);

  return (
    <main className="console-shell">
      <PageHead
        title="Pre-election operations"
        lead="Verification, referrals, rewards, payouts and strength analytics. Rewards follow verified membership and approved organisational work — never vote choice or proof of a ballot."
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        {message ? <Notice tone="ok" title={message} /> : null}
        {error ? <Notice tone="error" title="Something went wrong">{error}</Notice> : null}

        <KpiRow>
          <Kpi
            label="Awaiting review"
            value={formatCount(verificationCounts.PENDING || 0)}
            note="Verification cases in the validator queue"
            tone={(verificationCounts.PENDING || 0) > 0 ? "accent" : undefined}
          />
          <Kpi
            label="Eligible beneficiaries"
            value={formatCount(payoutEligibility.length)}
            note="Meet the active payout threshold"
          />
          <Kpi
            label="Payout batches"
            value={formatCount(payoutBatches.length)}
            note={`${formatCount(assignmentRows.length)} assignments shown`}
          />
          <Kpi
            label="Strength score"
            value={strengthDashboard?.latestStrengthSnapshot?.score ?? "—"}
            note={`${territory.territoryType.replace(/_/g, " ").toLowerCase()} scope`}
          />
        </KpiRow>

        {isValidator || isSuperAdmin ? (
          <Panel
            title="Validator queue"
            meta="Document access is audited and short lived"
            actions={
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => {
                  if (!token) return;
                  exportPreElectionVerificationsCsv(token, verificationFilter)
                    .then(() => setMessage("CSV export generated."))
                    .catch((caught) => setError(describeApiError(caught).detail));
                }}
              >
                Export CSV
              </button>
            }
            flush
          >
            <Toolbar>
              <ToolbarField label="Status">
                <select
                  value={verificationFilter.status}
                  onChange={(event) => setVerificationFilter({ ...verificationFilter, status: event.target.value })}
                >
                  {verificationStatuses.map((status) => (
                    <option key={status} value={status}>
                      {status.replace(/_/g, " ").toLowerCase()}
                    </option>
                  ))}
                </select>
              </ToolbarField>
              <ToolbarField label="Search member or VIN" hideLabel>
                <input
                  type="search"
                  placeholder="Search member or VIN"
                  value={verificationFilter.search}
                  onChange={(event) => setVerificationFilter({ ...verificationFilter, search: event.target.value })}
                />
              </ToolbarField>
              <ToolbarEnd>
                <button className="btn btn-sm" type="button" onClick={() => void reload()}>
                  Apply
                </button>
              </ToolbarEnd>
            </Toolbar>

            <DataTable
              head={
                <tr>
                  <th>Member</th>
                  <th>Status</th>
                  <th className="numeric">Docs</th>
                  <th>Decision note</th>
                  <th className="actions">Action</th>
                </tr>
              }
            >
              {verifications.length === 0 ? (
                <EmptyRow colSpan={5}>No verification cases match this filter.</EmptyRow>
              ) : (
                verifications.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.memberName}</strong>
                      <div className="muted-text">{item.memberEmail}</div>
                      {item.isFlagged ? (
                        <div className="pill pill-error" title={item.fraudReason || undefined}>
                          flagged
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <StatusPill status={item.status} />
                    </td>
                    <td className="numeric">{formatCount(item.documents.length)}</td>
                    <td>
                      <label className="sr-only" htmlFor={`note-${item.id}`}>
                        Decision note for {item.memberName}
                      </label>
                      <input
                        id={`note-${item.id}`}
                        placeholder="Reason for the decision"
                        value={decisionNoteById[item.id] || ""}
                        onChange={(event) => setDecisionNoteById({ ...decisionNoteById, [item.id]: event.target.value })}
                      />
                    </td>
                    <td className="actions">
                      <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => token && claimPreElectionVerification(token, item.id).then(() => reload())}
                        >
                          Claim
                        </button>
                        {item.documents[0] ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() =>
                              token &&
                              accessPreElectionVerificationDocument(token, item.id, item.documents[0].id)
                                .then((access) => {
                                  // A short-lived signed URL, opened once. This
                                  // previously reported a storage key and a
                                  // random token, and showed the validator
                                  // nothing: no document had ever been stored.
                                  window.open(access.url, "_blank", "noopener,noreferrer");
                                  setMessage(
                                    `Document opened. The link expires at ${new Date(access.expiresAt).toLocaleTimeString()} and the access is audited.`,
                                  );
                                })
                                .catch((caught) => setError(describeApiError(caught).detail))
                            }
                          >
                            Document
                          </button>
                        ) : null}
                        <button
                          className="btn btn-sm btn-primary"
                          type="button"
                          onClick={() => void handleVerificationDecision(item.id, "APPROVE")}
                        >
                          Approve
                        </button>
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={() => void handleVerificationDecision(item.id, "REQUEST_RESUBMISSION")}
                        >
                          Resubmit
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          type="button"
                          onClick={() => void handleVerificationDecision(item.id, "REJECT")}
                        >
                          Reject
                        </button>
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>
        ) : null}

        {referrals.length || canViewStrength ? (
          <PanelGrid wide>
            <Panel title="Referrals" meta={`${formatCount(referrals.length)} records`} flush>
              <Toolbar>
                <ToolbarField label="Status">
                  <select
                    value={referralFilter.status}
                    onChange={(event) => setReferralFilter({ ...referralFilter, status: event.target.value })}
                  >
                    <option value="">All statuses</option>
                    {referralStatuses.map((status) => (
                      <option key={status} value={status}>
                        {status.replace(/_/g, " ").toLowerCase()}
                      </option>
                    ))}
                  </select>
                </ToolbarField>
                <ToolbarField label="Search referred member" hideLabel>
                  <input
                    type="search"
                    placeholder="Search referred member"
                    value={referralFilter.search}
                    onChange={(event) => setReferralFilter({ ...referralFilter, search: event.target.value })}
                  />
                </ToolbarField>
                <ToolbarEnd>
                  <button className="btn btn-sm" type="button" onClick={() => void reload()}>
                    Apply
                  </button>
                </ToolbarEnd>
              </Toolbar>

              <DataTable
                head={
                  <tr>
                    <th>Referred member</th>
                    <th>Status</th>
                    <th>Referrer</th>
                    <th>Registered</th>
                  </tr>
                }
              >
                {referrals.length === 0 ? (
                  <EmptyRow colSpan={4}>No referrals match this filter.</EmptyRow>
                ) : (
                  referrals.slice(0, 25).map((item) => (
                    <tr key={item.id}>
                      <td>{item.referredName}</td>
                      <td>
                        <StatusPill status={item.status} />
                      </td>
                      <td>{item.referrerName}</td>
                      <td className="muted-text">{new Date(item.registeredAt).toLocaleDateString()}</td>
                    </tr>
                  ))
                )}
              </DataTable>
            </Panel>

            <Panel title="Strength and targets" flush>
              <Toolbar>
                <ToolbarField label="Territory type">
                  <select
                    value={territory.territoryType}
                    onChange={(event) => setTerritory({ ...territory, territoryType: event.target.value })}
                  >
                    {territoryTypes.map((type) => (
                      <option key={type} value={type}>
                        {type.replace(/_/g, " ").toLowerCase()}
                      </option>
                    ))}
                  </select>
                </ToolbarField>
                <ToolbarField label="Territory ID" hideLabel>
                  <input
                    type="text"
                    placeholder="Territory ID"
                    value={territory.territoryId}
                    onChange={(event) => setTerritory({ ...territory, territoryId: event.target.value })}
                  />
                </ToolbarField>
                <ToolbarEnd>
                  <button className="btn btn-sm" type="button" onClick={() => void reload()}>
                    Load
                  </button>
                </ToolbarEnd>
              </Toolbar>

              <div className="panel-body stack-4">
                {isSuperAdmin ? (
                  <form className="form-grid" onSubmit={handleStrengthConfigure}>
                    <Field label="Metric" hint="The strength measure this target applies to.">
                      <input
                        value={targetForm.metric}
                        onChange={(event) => setTargetForm({ ...targetForm, metric: event.target.value })}
                        required
                      />
                    </Field>
                    <Field label="Target value" hint="The figure the territory is working towards.">
                      <input
                        inputMode="numeric"
                        value={targetForm.targetValue}
                        onChange={(event) => setTargetForm({ ...targetForm, targetValue: event.target.value })}
                        required
                      />
                    </Field>
                    <div className="btn-row">
                      <button className="btn" type="submit">
                        Save target and recalculate
                      </button>
                    </div>
                  </form>
                ) : null}

                <DataTable
                  caption="Target progress"
                  head={
                    <tr>
                      <th>Metric</th>
                      <th className="numeric">Actual</th>
                      <th className="numeric">Target</th>
                      <th className="numeric">Achieved</th>
                      <th className="numeric">Shortfall</th>
                    </tr>
                  }
                >
                  {!strengthDashboard?.targetProgress.length ? (
                    <EmptyRow colSpan={5}>No targets set for this territory.</EmptyRow>
                  ) : (
                    strengthDashboard.targetProgress.map((target) => (
                      <tr key={target.targetId}>
                        <td>{target.metric.replace(/_/g, " ").toLowerCase()}</td>
                        <td className="numeric">{target.actualValue}</td>
                        <td className="numeric">{target.targetValue}</td>
                        <td className="numeric">{target.percentageAchieved}%</td>
                        <td className="numeric">{target.shortfall}</td>
                      </tr>
                    ))
                  )}
                </DataTable>

                <DataTable
                  caption="Coordinator performance"
                  head={
                    <tr>
                      <th>Coordinator</th>
                      <th>Level</th>
                      <th className="numeric">Verified referrals</th>
                      <th className="numeric">Points</th>
                    </tr>
                  }
                >
                  {!strengthDashboard?.coordinatorPerformance.length ? (
                    <EmptyRow colSpan={4}>No coordinator activity in this territory.</EmptyRow>
                  ) : (
                    strengthDashboard.coordinatorPerformance.slice(0, 10).map((item) => (
                      <tr key={item.userId}>
                        <td>{item.name}</td>
                        <td className="muted-text">{item.level.replace(/_/g, " ").toLowerCase()}</td>
                        <td className="numeric">{formatCount(item.directVerifiedRegistrations)}</td>
                        <td className="numeric">{formatCount(item.confirmedPoints)}</td>
                      </tr>
                    ))
                  )}
                </DataTable>
              </div>
            </Panel>
          </PanelGrid>
        ) : null}

        {isSuperAdmin ? (
          <PanelGrid>
            <Panel title="Reward rules">
              <form className="form-grid stack-3" onSubmit={handleRewardRuleSubmit}>
                <Field label="Rule name" hint="How this rule is identified in the audit trail.">
                  <input
                    value={rewardRuleForm.name}
                    onChange={(event) => setRewardRuleForm({ ...rewardRuleForm, name: event.target.value })}
                    required
                  />
                </Field>
                <Field label="Direct points" hint="Points minted for each qualifying action under this rule.">
                  <input
                    inputMode="numeric"
                    value={rewardRuleForm.directPoints}
                    onChange={(event) => setRewardRuleForm({ ...rewardRuleForm, directPoints: event.target.value })}
                    required
                  />
                </Field>
                <Field label="Eligible coordinator level" hint="Leave unset to apply at every level.">
                  <select
                    value={rewardRuleForm.eligibleCoordinatorLevel}
                    onChange={(event) =>
                      setRewardRuleForm({ ...rewardRuleForm, eligibleCoordinatorLevel: event.target.value })
                    }
                  >
                    <option value="">Any coordinator level</option>
                    {["SENATORIAL_DISTRICT", "FEDERAL_CONSTITUENCY", "STATE_CONSTITUENCY", "WARD", "POLLING_UNIT"].map(
                      (level) => (
                        <option key={level} value={level}>
                          {level.replace(/_/g, " ").toLowerCase()}
                        </option>
                      ),
                    )}
                  </select>
                </Field>
                <div className="btn-row">
                  <button className="btn btn-primary" type="submit">
                    Create reward rule
                  </button>
                </div>
              </form>

              <DataTable
                caption="Active rules"
                head={
                  <tr>
                    <th>Rule</th>
                    <th>Applies to</th>
                    <th className="numeric">Points</th>
                  </tr>
                }
              >
                {rewardRules.length === 0 ? (
                  <EmptyRow colSpan={3}>No reward rules defined.</EmptyRow>
                ) : (
                  rewardRules.slice(0, 8).map((rule) => (
                    <tr key={rule.id}>
                      <td>{rule.name}</td>
                      <td className="muted-text">
                        {rule.eligibleRole.replace(/_/g, " ").toLowerCase()} ·{" "}
                        {(rule.eligibleCoordinatorLevel || "ALL").replace(/_/g, " ").toLowerCase()}
                      </td>
                      <td className="numeric">{formatCount(rule.versions[0]?.directPoints ?? 0)}</td>
                    </tr>
                  ))
                )}
              </DataTable>
            </Panel>

            <Panel title="Payout policy" meta="Governs what a point is worth">
              <form className="form-grid stack-3" onSubmit={handlePayoutConfigSubmit}>
                <Field
                  label="Minimum points"
                  hint="A beneficiary below this threshold is not included in a payout batch."
                >
                  <input
                    inputMode="numeric"
                    value={payoutConfigForm.minimumPoints}
                    onChange={(event) => setPayoutConfigForm({ ...payoutConfigForm, minimumPoints: event.target.value })}
                    required
                  />
                </Field>
                <Field
                  label="Point conversion rate"
                  hint="Naira paid per point. This figure decides what every beneficiary receives."
                >
                  <input
                    inputMode="decimal"
                    value={payoutConfigForm.pointConversionRate}
                    onChange={(event) =>
                      setPayoutConfigForm({ ...payoutConfigForm, pointConversionRate: event.target.value })
                    }
                    required
                  />
                </Field>
                <Field label="Frequency" hint="How often a cycle opens.">
                  <select
                    value={payoutConfigForm.frequency}
                    onChange={(event) => setPayoutConfigForm({ ...payoutConfigForm, frequency: event.target.value })}
                  >
                    {["WEEKLY", "BIWEEKLY", "MONTHLY"].map((option) => (
                      <option key={option} value={option}>
                        {option.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="btn-row">
                  <button className="btn" type="submit">
                    Save payout policy
                  </button>
                </div>
              </form>
            </Panel>

            <Panel title="Payout cycle">
              <form className="form-grid stack-3" onSubmit={handlePayoutCycleSubmit}>
                <Field label="Cycle name">
                  <input
                    value={payoutCycleForm.name}
                    onChange={(event) => setPayoutCycleForm({ ...payoutCycleForm, name: event.target.value })}
                    required
                  />
                </Field>
                <Field label="Opens at">
                  <input
                    type="datetime-local"
                    value={payoutCycleForm.opensAt}
                    onChange={(event) => setPayoutCycleForm({ ...payoutCycleForm, opensAt: event.target.value })}
                    required
                  />
                </Field>
                <Field label="Closes at">
                  <input
                    type="datetime-local"
                    value={payoutCycleForm.closesAt}
                    onChange={(event) => setPayoutCycleForm({ ...payoutCycleForm, closesAt: event.target.value })}
                    required
                  />
                </Field>
                <Field label="Payout date">
                  <input
                    type="datetime-local"
                    value={payoutCycleForm.payoutDate}
                    onChange={(event) => setPayoutCycleForm({ ...payoutCycleForm, payoutDate: event.target.value })}
                    required
                  />
                </Field>
                <div className="btn-row">
                  <button className="btn" type="submit">
                    Create cycle
                  </button>
                </div>
              </form>
            </Panel>

            <Panel title="Batching" meta={`${formatCount(payoutEligibility.length)} eligible`}>
              <form className="form-grid stack-3" onSubmit={handlePayoutBatchSubmit}>
                <Field label="Payout cycle">
                  <select
                    value={payoutBatchForm.cycleId}
                    onChange={(event) => setPayoutBatchForm({ ...payoutBatchForm, cycleId: event.target.value })}
                    required
                  >
                    <option value="">Select cycle</option>
                    {payoutCycles.map((cycle) => (
                      <option key={cycle.id} value={cycle.id}>
                        {cycle.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Payout officer" hint="The officer who will process this batch.">
                  <select
                    value={payoutBatchForm.payoutOfficerUserId}
                    onChange={(event) =>
                      setPayoutBatchForm({ ...payoutBatchForm, payoutOfficerUserId: event.target.value })
                    }
                    required
                  >
                    <option value="">Select payout officer</option>
                    {payoutOfficers.map((officer) => (
                      <option key={officer.id} value={officer.id}>
                        {officer.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="btn-row">
                  <button className="btn btn-primary" type="submit" disabled={!payoutEligibility.length}>
                    Create batch for eligible beneficiaries
                  </button>
                </div>
              </form>

              <DataTable
                caption="Eligible beneficiaries — amounts are derived by the payout authority, not entered"
                head={
                  <tr>
                    <th>Beneficiary</th>
                    <th className="numeric">Points</th>
                    <th className="numeric">Amount</th>
                  </tr>
                }
              >
                {payoutEligibility.length === 0 ? (
                  <EmptyRow colSpan={3}>No beneficiary currently meets the active threshold.</EmptyRow>
                ) : (
                  payoutEligibility.slice(0, 15).map((item) => (
                    <tr key={item.userId}>
                      <td>
                        {item.name || item.userId}
                        {item.email ? <div className="muted-text">{item.email}</div> : null}
                      </td>
                      <td className="numeric">{formatCount(item.availablePoints)}</td>
                      <td className="numeric">
                        <Money amount={item.amount} provenance="revalued" />
                      </td>
                    </tr>
                  ))
                )}
              </DataTable>
            </Panel>
          </PanelGrid>
        ) : null}

        {isSuperAdmin || isPayoutOfficer ? (
          <Panel
            title="Payout processing"
            meta="Payout officers process only assigned records and cannot change reward or payout policy"
            actions={
              <button className="btn btn-sm" type="button" onClick={() => void reload()}>
                Refresh
              </button>
            }
            flush
          >
            <Toolbar>
              <ToolbarField label="Status">
                <select value={payoutStatus} onChange={(event) => setPayoutStatus(event.target.value)}>
                  <option value="">All statuses</option>
                  {payoutStatuses.map((status) => (
                    <option key={status} value={status}>
                      {status.toLowerCase()}
                    </option>
                  ))}
                </select>
              </ToolbarField>
            </Toolbar>

            {payoutExecutionEnabled === false || payoutMessage || payoutProblem ? (
              <div className="panel-body stack-2">
                {payoutExecutionEnabled === false ? (
                  <Notice tone="refused" title="Payout execution is disabled">
                    <span>
                      No payment can complete while PAYOUT_EXECUTION_ENABLED is false. This is the default in every
                      environment, production included, and is cleared only by a deliberate operator action.
                    </span>
                  </Notice>
                ) : null}
                {payoutMessage ? <Notice tone="ok" title={payoutMessage} /> : null}
                {payoutProblem ? (
                  <Notice tone={payoutProblem.refused ? "refused" : "error"} title={payoutProblem.title}>
                    <span>{payoutProblem.detail}</span>
                    {payoutProblem.nextStep ? <span className="muted-text">{payoutProblem.nextStep}</span> : null}
                  </Notice>
                ) : null}
              </div>
            ) : null}

            <DataTable
              head={
                <tr>
                  <th>Beneficiary</th>
                  <th className="numeric">Points</th>
                  <th className="numeric">Amount</th>
                  <th>Status</th>
                  <th>Payment reference</th>
                  <th className="actions">Action</th>
                </tr>
              }
            >
              {assignmentRows.length === 0 ? (
                <EmptyRow colSpan={6}>No payout assignments to process.</EmptyRow>
              ) : (
                assignmentRows.map((assignment) => {
                  const execution = assignment.transactions?.[0];
                  return (
                    <tr key={assignment.id}>
                      <td>{assignment.beneficiaryName || assignment.beneficiaryUserId}</td>
                      <td className="numeric">{formatCount(assignment.points)}</td>
                      <td className="numeric">{formatMoney(assignment.amount)}</td>
                      <td>
                        <StatusPill status={assignment.status} />
                      </td>
                      <td className="muted-text">
                        {/* The proof a payment happened. It was fetched on every load and rendered nowhere. */}
                        {execution ? execution.paymentReference : "—"}
                      </td>
                      <td className="actions">
                        {assignment.status === "PAID" ? (
                          <span className="muted-text">Executed</span>
                        ) : (
                          <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                            <button
                              className="btn btn-sm"
                              type="button"
                              disabled={payoutBusy !== null}
                              onClick={() =>
                                void runPayout(`processing-${assignment.id}`, async (activeToken) => {
                                  await updatePreElectionPayoutAssignment(activeToken, assignment.id, { status: "PROCESSING" });
                                  return "Assignment moved to processing.";
                                })
                              }
                            >
                              Processing
                            </button>
                            <button
                              className="btn btn-sm btn-primary"
                              type="button"
                              disabled={payoutBusy !== null || payoutExecutionEnabled === false}
                              title={
                                payoutExecutionEnabled === false
                                  ? "Payout execution is disabled — this would be refused"
                                  : undefined
                              }
                              onClick={() => setPayingAssignment(assignment)}
                            >
                              Mark paid…
                            </button>
                            <button
                              className="btn btn-sm"
                              type="button"
                              disabled={payoutBusy !== null}
                              onClick={() =>
                                void runPayout(`hold-${assignment.id}`, async (activeToken) => {
                                  await updatePreElectionPayoutAssignment(activeToken, assignment.id, {
                                    status: "HELD",
                                    note: "Held for review.",
                                  });
                                  return "Assignment held for review.";
                                })
                              }
                            >
                              Hold
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </DataTable>

            <PaymentReferenceDialog
              open={payingAssignment !== null}
              busy={payoutBusy !== null}
              title="Record payout payment"
              summary={
                payingAssignment ? (
                  <>
                    {payingAssignment.beneficiaryName || payingAssignment.beneficiaryUserId} ·{" "}
                    {formatCount(payingAssignment.points)} points · {formatMoney(payingAssignment.amount)}. The reference
                    is written to an immutable execution record and may identify only this payment.
                  </>
                ) : null
              }
              onCancel={() => setPayingAssignment(null)}
              onConfirm={(input) => {
                const target = payingAssignment;
                if (!target) return;
                void runPayout(`paid-${target.id}`, async (activeToken) => {
                  await updatePreElectionPayoutAssignment(activeToken, target.id, { status: "PAID", ...input });
                  setPayingAssignment(null);
                  return "Payment recorded.";
                });
              }}
            />

            {isSuperAdmin ? (
              <DataTable
                caption="Batches"
                head={
                  <tr>
                    <th>Cycle</th>
                    <th>Status</th>
                    <th className="numeric">Assignments</th>
                    <th className="numeric">Total</th>
                    <th className="actions">Action</th>
                  </tr>
                }
              >
                {payoutBatches.length === 0 ? (
                  <EmptyRow colSpan={5}>No payout batches created.</EmptyRow>
                ) : (
                  payoutBatches.map((batch) => (
                    <tr key={batch.id}>
                      <td>{batch.payoutCycleName || batch.payoutCycleId}</td>
                      <td>
                        <StatusPill status={batch.status} />
                      </td>
                      <td className="numeric">{formatCount(batch.assignmentCount)}</td>
                      <td className="numeric">{formatMoney(batch.totalAmount)}</td>
                      <td className="actions">
                        <button
                          className="btn btn-sm"
                          type="button"
                          disabled={payoutBusy !== null}
                          onClick={() =>
                            void runPayout(`batch-${batch.id}`, async (activeToken) => {
                              await approvePreElectionPayoutBatch(activeToken, batch.id);
                              return "Batch approved.";
                            })
                          }
                        >
                          Approve batch
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </DataTable>
            ) : null}
          </Panel>
        ) : null}
      </div>
    </main>
  );
}
