"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { OGUN_STATE_ID, type AuthUserProfile } from "@pics-nigeria/shared";
import { AdminNav } from "../../../components/admin-nav";
import { PaymentReferenceDialog } from "../../../components/payment-reference-dialog";
import { DataTable, Notice, StatusPill, formatCount, formatMoney } from "../../../components/ui";
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
      <main className="shell">
        <section className="panel hero">
          <h1>Loading pre-election workspace...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load pre-election workspace</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/login">Return to admin login</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Sprint 3 Pre-Election</p>
        <h1>Product completion workspace</h1>
        <p>
          Verification, referrals, rewards, payouts, and strength analytics for pre-election organization. Rewards are limited to verified membership and approved organizational work, never vote choice or ballot proof.
        </p>
      </section>

      <AdminNav role={user?.role} />
      {message ? <p className="feedback-banner success">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <section className="grid stats">
        <article className="panel card">
          <h2>Pending Reviews</h2>
          <div className="value">{verificationCounts.PENDING || 0}</div>
        </article>
        <article className="panel card">
          <h2>Referral Records</h2>
          <div className="value">{referralSummary.total || referrals.length}</div>
        </article>
        <article className="panel card">
          <h2>Payout Batches</h2>
          <div className="value">{payoutBatches.length}</div>
        </article>
        <article className="panel card">
          <h2>Strength Score</h2>
          <div className="value">{strengthDashboard?.latestStrengthSnapshot?.score || "N/A"}</div>
        </article>
      </section>

      {isValidator || isSuperAdmin ? (
        <section className="panel card" style={{ marginTop: 24 }}>
          <div className="section-head">
            <div>
              <h2>Validator Queue</h2>
              <p className="muted">Claim, review, approve, reject, or request resubmission. Document access is audited and short lived.</p>
            </div>
            <button className="button secondary" type="button" onClick={() => token && exportPreElectionVerificationsCsv(token, verificationFilter).then(() => setMessage("CSV export generated."))}>
              Export CSV
            </button>
          </div>
          <div className="map-filter-row" style={{ marginBottom: 16 }}>
            <select value={verificationFilter.status} onChange={(event) => setVerificationFilter({ ...verificationFilter, status: event.target.value })}>
              {verificationStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
            <input placeholder="Search member or VIN" value={verificationFilter.search} onChange={(event) => setVerificationFilter({ ...verificationFilter, search: event.target.value })} />
            <button className="button secondary" type="button" onClick={() => void reload()}>Apply</button>
          </div>
          <div className="reward-list">
            {verifications.map((item) => (
              <article key={item.id} className="reward-item">
                <strong>{item.memberName}</strong>
                <p>{item.memberEmail} | {item.status} | {item.documents.length} document(s)</p>
                {item.isFlagged ? <p className="error">Flagged: {item.fraudReason}</p> : null}
                <input placeholder="Decision note" value={decisionNoteById[item.id] || ""} onChange={(event) => setDecisionNoteById({ ...decisionNoteById, [item.id]: event.target.value })} />
                <div className="action-row" style={{ marginTop: 12 }}>
                  <button className="button secondary" type="button" onClick={() => token && claimPreElectionVerification(token, item.id).then(() => reload())}>Claim</button>
                  {item.documents[0] ? (
                    <button className="button secondary" type="button" onClick={() => token && accessPreElectionVerificationDocument(token, item.id, item.documents[0].id).then((access) => setMessage(`Access token issued for ${access.storageKey}`))}>
                      Access document
                    </button>
                  ) : null}
                  <button className="button" type="button" onClick={() => void handleVerificationDecision(item.id, "APPROVE")}>Approve</button>
                  <button className="button secondary" type="button" onClick={() => void handleVerificationDecision(item.id, "REQUEST_RESUBMISSION")}>Resubmit</button>
                  <button className="button danger" type="button" onClick={() => void handleVerificationDecision(item.id, "REJECT")}>Reject</button>
                </div>
                {item.history.length ? <p className="muted">Latest history: {item.history[0].decision} at {new Date(item.history[0].createdAt).toLocaleString()}</p> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {referrals.length || canViewStrength ? (
        <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
          <section className="panel card">
            <h2>Referral Dashboard</h2>
            <div className="map-filter-row" style={{ marginBottom: 16 }}>
              <select value={referralFilter.status} onChange={(event) => setReferralFilter({ ...referralFilter, status: event.target.value })}>
                <option value="">All statuses</option>
                {referralStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <input placeholder="Search referred member" value={referralFilter.search} onChange={(event) => setReferralFilter({ ...referralFilter, search: event.target.value })} />
              <button className="button secondary" type="button" onClick={() => void reload()}>Apply</button>
            </div>
            <div className="badge-row" style={{ marginBottom: 16 }}>
              {Object.entries(referralSummary).map(([label, count]) => <span key={label} className="status-badge live">{label}: {count}</span>)}
            </div>
            <div className="reward-list">
              {referrals.slice(0, 10).map((item) => (
                <article key={item.id} className="reward-item">
                  <strong>{item.referredName}</strong>
                  <p>{item.status} via {item.referrerName}</p>
                  <p className="muted">Registered {new Date(item.registeredAt).toLocaleString()}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="panel card">
            <h2>Strength, Targets, Performance</h2>
            <div className="map-filter-row" style={{ marginBottom: 16 }}>
              <select value={territory.territoryType} onChange={(event) => setTerritory({ ...territory, territoryType: event.target.value })}>
                {territoryTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <input value={territory.territoryId} onChange={(event) => setTerritory({ ...territory, territoryId: event.target.value })} />
              <button className="button secondary" type="button" onClick={() => void reload()}>Load</button>
            </div>
            {isSuperAdmin ? (
              <form className="form" onSubmit={handleStrengthConfigure} style={{ marginBottom: 16 }}>
                <input value={targetForm.metric} onChange={(event) => setTargetForm({ ...targetForm, metric: event.target.value })} />
                <input value={targetForm.targetValue} onChange={(event) => setTargetForm({ ...targetForm, targetValue: event.target.value })} />
                <button className="button secondary" type="submit">Save target and calculate</button>
              </form>
            ) : null}
            {strengthDashboard?.targetProgress.map((target) => (
              <article key={target.targetId} className="reward-item">
                <strong>{target.metric}</strong>
                <p>{target.actualValue} / {target.targetValue} ({target.percentageAchieved}%)</p>
                <p className="muted">Shortfall: {target.shortfall}</p>
              </article>
            ))}
            <h3>Coordinator Performance</h3>
            <div className="reward-list">
              {strengthDashboard?.coordinatorPerformance.slice(0, 8).map((item) => (
                <article key={item.userId} className="reward-item">
                  <strong>{item.name}</strong>
                  <p>{item.level} | Verified referrals: {item.directVerifiedRegistrations} | Points: {item.confirmedPoints}</p>
                </article>
              ))}
            </div>
          </section>
        </section>
      ) : null}

      {isSuperAdmin ? (
        <section className="grid" style={{ marginTop: 24, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
          <section className="panel card">
            <h2>Reward Configuration</h2>
            <form className="form" onSubmit={handleRewardRuleSubmit}>
              <input value={rewardRuleForm.name} onChange={(event) => setRewardRuleForm({ ...rewardRuleForm, name: event.target.value })} />
              <input value={rewardRuleForm.directPoints} onChange={(event) => setRewardRuleForm({ ...rewardRuleForm, directPoints: event.target.value })} />
              <select value={rewardRuleForm.eligibleCoordinatorLevel} onChange={(event) => setRewardRuleForm({ ...rewardRuleForm, eligibleCoordinatorLevel: event.target.value })}>
                <option value="">Any coordinator level</option>
                {["SENATORIAL_DISTRICT", "FEDERAL_CONSTITUENCY", "STATE_CONSTITUENCY", "WARD", "POLLING_UNIT"].map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
              <button className="button" type="submit">Create reward rule</button>
            </form>
            <div className="reward-list" style={{ marginTop: 16 }}>
              {rewardRules.slice(0, 5).map((rule) => (
                <article key={rule.id} className="reward-item">
                  <strong>{rule.name}</strong>
                  <p>{rule.eligibleRole} {rule.eligibleCoordinatorLevel || "ALL"} | {rule.versions[0]?.directPoints ?? 0} points</p>
                </article>
              ))}
            </div>
          </section>

          <section className="panel card">
            <h2>Payout Setup</h2>
            <form className="form" onSubmit={handlePayoutConfigSubmit}>
              <input value={payoutConfigForm.minimumPoints} onChange={(event) => setPayoutConfigForm({ ...payoutConfigForm, minimumPoints: event.target.value })} />
              <input value={payoutConfigForm.pointConversionRate} onChange={(event) => setPayoutConfigForm({ ...payoutConfigForm, pointConversionRate: event.target.value })} />
              <input value={payoutConfigForm.frequency} onChange={(event) => setPayoutConfigForm({ ...payoutConfigForm, frequency: event.target.value })} />
              <button className="button secondary" type="submit">Save payout policy</button>
            </form>
            <form className="form" onSubmit={handlePayoutCycleSubmit} style={{ marginTop: 16 }}>
              <input value={payoutCycleForm.name} onChange={(event) => setPayoutCycleForm({ ...payoutCycleForm, name: event.target.value })} />
              <input type="datetime-local" value={payoutCycleForm.opensAt} onChange={(event) => setPayoutCycleForm({ ...payoutCycleForm, opensAt: event.target.value })} />
              <input type="datetime-local" value={payoutCycleForm.closesAt} onChange={(event) => setPayoutCycleForm({ ...payoutCycleForm, closesAt: event.target.value })} />
              <input type="datetime-local" value={payoutCycleForm.payoutDate} onChange={(event) => setPayoutCycleForm({ ...payoutCycleForm, payoutDate: event.target.value })} />
              <button className="button secondary" type="submit">Create cycle</button>
            </form>
          </section>

          <section className="panel card">
            <h2>Payout Batching</h2>
            <form className="form" onSubmit={handlePayoutBatchSubmit}>
              <select value={payoutBatchForm.cycleId} onChange={(event) => setPayoutBatchForm({ ...payoutBatchForm, cycleId: event.target.value })} required>
                <option value="">Select cycle</option>
                {payoutCycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}
              </select>
              <select value={payoutBatchForm.payoutOfficerUserId} onChange={(event) => setPayoutBatchForm({ ...payoutBatchForm, payoutOfficerUserId: event.target.value })} required>
                <option value="">Select payout officer</option>
                {payoutOfficers.map((officer) => <option key={officer.id} value={officer.id}>{officer.name}</option>)}
              </select>
              <button className="button" type="submit" disabled={!payoutEligibility.length}>Create batch for eligible users</button>
            </form>
            <p className="muted">{payoutEligibility.length} eligible beneficiaries currently meet the active threshold.</p>
          </section>
        </section>
      ) : null}

      {isSuperAdmin || isPayoutOfficer ? (
        <section className="panel card" style={{ marginTop: 24 }}>
          <div className="section-head">
            <div>
              <h2>Payout Processing</h2>
              <p className="muted">Payout officers can process only assigned records and cannot change rewards or payout policy.</p>
            </div>
            <select value={payoutStatus} onChange={(event) => setPayoutStatus(event.target.value)}>
              <option value="">All statuses</option>
              {payoutStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </div>
          <button className="button secondary" type="button" onClick={() => void reload()}>Refresh payouts</button>
          {payoutExecutionEnabled === false ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="refused" title="Payout execution is disabled">
                <span>
                  No payment can complete while PAYOUT_EXECUTION_ENABLED is false. This is the default in every
                  environment, production included, and is cleared only by a deliberate operator action.
                </span>
              </Notice>
            </div>
          ) : null}
          {payoutMessage ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="ok" title={payoutMessage} />
            </div>
          ) : null}
          {payoutProblem ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone={payoutProblem.refused ? "refused" : "error"} title={payoutProblem.title}>
                <span>{payoutProblem.detail}</span>
                {payoutProblem.nextStep ? <span className="muted-text">{payoutProblem.nextStep}</span> : null}
              </Notice>
            </div>
          ) : null}
          <div style={{ marginTop: 16 }}>
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
              {(isPayoutOfficer ? payoutAssignments : payoutBatches.flatMap((batch) => batch.assignments))
                .slice(0, 50)
                .map((assignment) => {
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
                })}
            </DataTable>
          </div>

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
            <div className="reward-list" style={{ marginTop: 16 }}>
              {payoutBatches.map((batch) => (
                <article key={batch.id} className="reward-item">
                  <strong>{batch.payoutCycleName || batch.payoutCycleId}</strong>
                  <p>{batch.status} | {batch.assignmentCount} assignments | NGN {batch.totalAmount}</p>
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
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
