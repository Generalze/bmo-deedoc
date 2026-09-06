"use client";

import Link from "next/link";
import { FormEvent, useMemo, useEffect, useState } from "react";
import type {
  AuthUserProfile,
  CampaignEventItem,
  NotificationItem,
  PostListItem,
  RewardBalanceSummary,
  RewardHistoryItem,
  RewardRedemptionItem,
  RewardsSummary,
  VoterEngagementTaskItem,
} from "@pics-nigeria/shared";
import {
  ApiError,
  claimVoterEngagementTask,
  createVoterRedemption,
  fetchCurrentUser,
  fetchMyPreElectionVerification,
  fetchNotifications,
  fetchPreElectionRewardBalance,
  fetchPreElectionRewardLedger,
  fetchVoterEvents,
  fetchVoterEngagementTasks,
  fetchVoterPosts,
  fetchVoterRewardLedger,
  fetchVoterRedemptions,
  fetchVoterRewards,
  logoutCurrentUser,
  rsvpToCampaignEvent,
  submitMyPreElectionVerificationDocument,
} from "../../lib/api";
import type { PreElectionVerificationCase } from "../../lib/api";
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
  formatCount,
  formatMoney,
} from "../../components/ui";
import { clearSession, readSession } from "../../lib/session";

async function sha256File(file: File) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeStorageName(fileName: string) {
  return fileName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "voter-document";
}

export default function DashboardPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [rewards, setRewards] = useState<RewardsSummary | null>(null);
  const [balance, setBalance] = useState<RewardBalanceSummary | null>(null);
  const [redemptions, setRedemptions] = useState<RewardRedemptionItem[]>([]);
  const [rewardHistory, setRewardHistory] = useState<RewardHistoryItem[]>([]);
  const [preElectionBalance, setPreElectionBalance] = useState<{
    confirmedPoints: number;
    pendingPotentialPoints: number;
    reservedPayoutPoints: number;
    availablePoints: number;
    legacyCarryoverPendingPoints: number;
    legacyCarryoverConfirmedPoints: number;
    preCutoverReservedPoints: number;
    payablePoints: number;
  } | null>(null);
  const [verification, setVerification] = useState<PreElectionVerificationCase | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [posts, setPosts] = useState<PostListItem[]>([]);
  const [events, setEvents] = useState<CampaignEventItem[]>([]);
  const [engagementTasks, setEngagementTasks] = useState<VoterEngagementTaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ pointsRequested: "", note: "" });
  const [documentConsent, setDocumentConsent] = useState(false);
  const [verificationDocument, setVerificationDocument] = useState<File | null>(null);
  const [message, setMessage] = useState("");

  const rewardSourceBreakdown = useMemo(() => {
    return rewardHistory.reduce<Record<string, number>>((accumulator, entry) => {
      const key = entry.kind === "EARNED" ? entry.title : entry.status;
      accumulator[key] = (accumulator[key] || 0) + 1;
      return accumulator;
    }, {});
  }, [rewardHistory]);

  async function loadDashboard(token: string) {
    const [
      currentUser,
      rewardSummary,
      rewardLedgerData,
      targetRewardBalance,
      targetRewardLedger,
      voterVerification,
      redemptionData,
      notificationItems,
      visiblePosts,
      visibleEvents,
      nextEngagementTasks,
    ] = await Promise.all([
      fetchCurrentUser(token),
      fetchVoterRewards(token),
      fetchVoterRewardLedger(token),
      fetchPreElectionRewardBalance(token),
      fetchPreElectionRewardLedger(token),
      fetchMyPreElectionVerification(token),
      fetchVoterRedemptions(token),
      fetchNotifications(token),
      fetchVoterPosts(token),
      fetchVoterEvents(token),
      fetchVoterEngagementTasks(token),
    ]);

    if (currentUser.role !== "VOTER" && currentUser.role !== "MEMBER") {
      throw new ApiError("This starter dashboard is available to members only.", 403);
    }

    setUser(currentUser);
    setRewards(rewardSummary);
    setBalance(redemptionData.balance);
    setRedemptions(redemptionData.redemptions);
    setRewardHistory([
      ...targetRewardLedger.map((entry) => ({
        id: entry.id,
        kind: "EARNED" as const,
        title: entry.category,
        description: entry.description || entry.rewardRuleName || "Pre-election ledger entry",
        status: "POSTED" as const,
        points: entry.points,
        amount: null,
        createdAt: entry.createdAt,
        reviewedAt: null,
      })),
      ...rewardLedgerData.rewardHistory,
    ]);
    setPreElectionBalance(targetRewardBalance);
    setVerification(voterVerification);
    setNotifications(notificationItems);
    setPosts(visiblePosts);
    setEvents(visibleEvents);
    setEngagementTasks(nextEngagementTasks);
  }

  useEffect(() => {
    const token = readSession();

    if (!token) {
      window.location.href = "/login";
      return;
    }
    const authToken = token;

    async function loadDashboardData() {
      try {
        await loadDashboard(authToken);
      } catch (caughtError) {
        clearSession();
        setError(caughtError instanceof Error ? caughtError.message : "Could not load your dashboard.");
      } finally {
        setLoading(false);
      }
    }

    void loadDashboardData();
  }, []);

  async function handleRedemptionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    setMessage("");

    try {
      await createVoterRedemption(token, {
        pointsRequested: Number(form.pointsRequested),
        note: form.note || undefined,
      });
      setForm({ pointsRequested: "", note: "" });
      setMessage("Redemption request submitted.");
      await loadDashboard(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Redemption request failed.");
    }
  }

  async function handleVerificationDocumentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = readSession();
    if (!token || !verificationDocument) {
      setError("Authentication and a voter evidence file are required.");
      return;
    }
    if (!documentConsent) {
      setError("Document processing consent is required before evidence submission.");
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(verificationDocument.type)) {
      setError("Upload a JPG, PNG, WebP, or PDF voter evidence file.");
      return;
    }

    setMessage("");
    setError("");
    try {
      const result = await submitMyPreElectionVerificationDocument(token, {
        documentProcessingConsent: true,
        voterDocument: {
          originalStorageKey: `voter-verification/client/${crypto.randomUUID()}-${safeStorageName(verificationDocument.name)}`,
          originalFileName: verificationDocument.name,
          mimeType: verificationDocument.type as "image/jpeg" | "image/png" | "image/webp" | "application/pdf",
          fileSize: verificationDocument.size,
          sha256: await sha256File(verificationDocument),
        },
      });
      setMessage(result.message);
      setDocumentConsent(false);
      setVerificationDocument(null);
      await loadDashboard(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not submit voter evidence.");
    }
  }

  async function handleClaimTask(taskId: string) {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    setMessage("");
    try {
      const result = await claimVoterEngagementTask(token, taskId);
      setMessage(result.message);
      await loadDashboard(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not claim engagement task.");
    }
  }

  async function handleEventRsvp(eventId: string, status: "INTERESTED" | "GOING") {
    const token = readSession();
    if (!token) {
      setError("Authentication is required.");
      return;
    }

    setMessage("");
    try {
      const result = await rsvpToCampaignEvent(token, eventId, { status });
      setMessage(result.message);
      await loadDashboard(token);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not save your event RSVP.");
    }
  }

  async function handleLogout() {
    const token = readSession();
    if (token) {
      try {
        await logoutCurrentUser(token);
      } catch {
        // Best effort.
      }
    }

    clearSession();
    window.location.href = "/login";
  }

  if (loading) {
    return (
      <main className="console-shell">
        <PageHead title="Your dashboard" />
        <StateView kind="loading" title="Preparing your account…" />
      </main>
    );
  }

  if (!user || !rewards || !balance) {
    return (
      <main className="console-shell">
        <PageHead title="Your dashboard" />
        <StateView
          kind="error"
          title="Unable to load your dashboard"
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

  /**
   * The one number a member can actually spend.
   *
   * The API reports `availablePoints` and `payablePoints` as the same figure —
   * confirmed points less what is already reserved — and deliberately keeps
   * migrated legacy value out of it. Everything else on this screen is context
   * for that number, so only it is rendered at full size.
   */
  const availablePoints = preElectionBalance?.availablePoints ?? balance.availablePoints;
  const legacyPending = balance.legacyCarryoverPendingPoints;

  return (
    <main className="console-shell">
      <PageHead
        title={`Welcome, ${user.name}`}
        lead={
          user.voterProfile?.referralCode ? (
            <>
              Your referral code is <strong>{user.voterProfile.referralCode}</strong>.
            </>
          ) : undefined
        }
        actions={
          <button className="btn" type="button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        }
      />

      <div className="stack-4">
        {error ? <Notice tone="error" title="Something went wrong">{error}</Notice> : null}
        {message ? <Notice tone="ok" title={message} /> : null}

        <KpiRow>
          <Kpi
            label="Available to redeem"
            value={formatCount(availablePoints)}
            note="Confirmed points less anything already reserved"
            tone="accent"
          />
          <Kpi label="Confirmed" value={formatCount(preElectionBalance?.confirmedPoints ?? rewards.totalPoints)} note="Posted to your ledger" />
          <Kpi
            label="Pending potential"
            value={formatCount(preElectionBalance?.pendingPotentialPoints ?? 0)}
            note="Not yet earned"
          />
          <Kpi
            label="Reserved"
            value={formatCount(preElectionBalance?.reservedPayoutPoints ?? balance.reservedPoints)}
            note={
              preElectionBalance?.preCutoverReservedPoints
                ? `Includes ${formatCount(preElectionBalance.preCutoverReservedPoints)} claimed before the legacy cutover`
                : "Held against a redemption or payout"
            }
            tone={preElectionBalance?.preCutoverReservedPoints ? "warn" : undefined}
          />
          {legacyPending > 0 ? (
            <Kpi
              label="Preserved legacy"
              value={
                <>
                  {formatCount(legacyPending)}{" "}
                  <span className="pill pill-legacy">Not payable</span>
                </>
              }
              note="Becomes spendable only once an approved conversion rate is applied"
              tone="warn"
            />
          ) : null}
        </KpiRow>

        <Panel
          title="Voter verification"
          meta={<StatusPill status={verification?.status || "NOT_SUBMITTED"} />}
        >
          <div className="stack-3">
            <p className="muted-text">
              Voter-registration verification gates referral rewards. Rewards never depend on vote choice, ballot
              proof, or proof of voting for any candidate.
            </p>

            {verification?.reviewNote ? (
              <Notice tone="legacy" title="Reviewer note">
                <span>{verification.reviewNote}</span>
              </Notice>
            ) : null}
            {verification?.isFlagged ? (
              <Notice tone="error" title="Flagged for review">
                <span>{verification.fraudReason || "Additional validator review required."}</span>
              </Notice>
            ) : null}

            {verification && ["NOT_SUBMITTED", "RESUBMISSION_REQUIRED", "PENDING"].includes(verification.status) ? (
              <form className="stack-3" onSubmit={handleVerificationDocumentSubmit}>
                <Field
                  label={verification.status === "RESUBMISSION_REQUIRED" ? "Resubmit voter evidence" : "Submit voter evidence"}
                  hint="JPG, PNG, WebP or PDF. Files are held as private storage metadata."
                >
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(event) => setVerificationDocument(event.target.files?.[0] || null)}
                  />
                </Field>
                <label className="cluster">
                  <input
                    type="checkbox"
                    checked={documentConsent}
                    onChange={(event) => setDocumentConsent(event.target.checked)}
                    required
                  />
                  <span>I consent to private processing of this voter-registration evidence by authorised validators.</span>
                </label>
                <div className="btn-row">
                  <button className="btn btn-primary" type="submit" disabled={!verificationDocument || !documentConsent}>
                    Submit evidence
                  </button>
                </div>
              </form>
            ) : null}

            <DataTable
              caption="Verification history"
              head={
                <tr>
                  <th>Decision</th>
                  <th>Transition</th>
                  <th>Note</th>
                  <th>When</th>
                </tr>
              }
            >
              {!verification?.history.length ? (
                <EmptyRow colSpan={4}>No verification history yet.</EmptyRow>
              ) : (
                verification.history.slice(0, 5).map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.decision}</td>
                    <td className="muted-text">
                      {entry.fromStatus || "NEW"} → {entry.toStatus}
                    </td>
                    <td className="muted-text">{entry.note || "—"}</td>
                    <td className="muted-text">
                      {new Date(entry.createdAt).toLocaleString()}
                      {entry.actorName ? ` · ${entry.actorName}` : ""}
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          </div>
        </Panel>

        <PanelGrid>
          <Panel title="Request redemption" meta={`${formatCount(availablePoints)} available`}>
            <form className="stack-3" onSubmit={handleRedemptionSubmit}>
              <Field
                label="Points requested"
                hint={
                  legacyPending > 0
                    ? `You may request up to ${formatCount(availablePoints)}. Your preserved legacy balance is not included and cannot be redeemed yet.`
                    : `You may request up to ${formatCount(availablePoints)}.`
                }
              >
                <input
                  inputMode="numeric"
                  max={availablePoints}
                  min={1}
                  value={form.pointsRequested}
                  onChange={(event) => setForm({ ...form, pointsRequested: event.target.value })}
                  required
                />
              </Field>
              {/* No amount field. The payable value is computed by the server
                  from the member's balance and the configured conversion rate;
                  asking the payee to state it invited the client to be
                  authoritative for money. */}
              <Field label="Note" hint="Optional.">
                <input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
              </Field>
              <div className="btn-row">
                <button className="btn btn-primary" type="submit" disabled={availablePoints <= 0}>
                  Submit redemption
                </button>
              </div>
            </form>
          </Panel>

          <Panel title="Notifications" meta={formatCount(notifications.length)}>
            {notifications.length === 0 ? (
              <StateView kind="empty" title="No notifications yet" />
            ) : (
              <ul className="stack-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {notifications.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <strong>{item.title}</strong>
                    <p className="muted-text">{item.message}</p>
                    <p className="muted-text">{new Date(item.createdAt).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </PanelGrid>

        <Panel
          title="Reward history"
          meta={`${formatCount(rewardHistory.length)} entries`}
          flush
        >
          {rewardHistory.length > 0 ? (
            <Toolbar>
              <span className="cluster">
                {Object.entries(rewardSourceBreakdown)
                  .slice(0, 6)
                  .map(([label, count]) => (
                    <span key={label} className="pill pill-stale">
                      {label}: {count}
                    </span>
                  ))}
              </span>
            </Toolbar>
          ) : null}
          <DataTable
            head={
              <tr>
                <th>Entry</th>
                <th>Kind</th>
                <th>Status</th>
                <th className="numeric">Points</th>
                <th className="numeric">Amount</th>
                <th>When</th>
              </tr>
            }
          >
            {rewardHistory.length === 0 ? (
              <EmptyRow colSpan={6}>No reward history yet.</EmptyRow>
            ) : (
              rewardHistory.slice(0, 12).map((entry) => (
                <tr key={`${entry.kind}-${entry.id}`}>
                  <td>
                    <strong>{entry.title}</strong>
                    {entry.description ? <div className="muted-text">{entry.description}</div> : null}
                  </td>
                  <td className="muted-text">{entry.kind === "EARNED" ? "Earned" : "Redemption"}</td>
                  <td>
                    <StatusPill status={entry.status} />
                  </td>
                  <td className="numeric">{formatCount(entry.points)}</td>
                  <td className="numeric">{entry.amount !== null ? formatMoney(entry.amount) : "—"}</td>
                  <td className="muted-text">
                    {new Date(entry.createdAt).toLocaleDateString()}
                    {entry.reviewedAt ? ` · reviewed ${new Date(entry.reviewedAt).toLocaleDateString()}` : ""}
                  </td>
                </tr>
              ))
            )}
          </DataTable>
        </Panel>

        <Panel title="Redemption history" meta={`${formatCount(redemptions.length)} requests`} flush>
          <DataTable
            head={
              <tr>
                <th>Status</th>
                <th className="numeric">Points requested</th>
                <th className="numeric">Payable amount</th>
                <th>Requested</th>
                <th>Review note</th>
              </tr>
            }
          >
            {redemptions.length === 0 ? (
              <EmptyRow colSpan={5}>No redemption requests yet.</EmptyRow>
            ) : (
              redemptions.map((item) => (
                <tr key={item.id}>
                  <td>
                    <StatusPill status={item.status} />
                  </td>
                  <td className="numeric">{formatCount(item.pointsRequested)}</td>
                  <td className="numeric">
                    {item.amountRequested !== null ? (
                      <Money amount={item.amountRequested} provenance="revalued" />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="muted-text">{new Date(item.createdAt).toLocaleDateString()}</td>
                  <td className="muted-text">{item.note || "—"}</td>
                </tr>
              ))
            )}
          </DataTable>
        </Panel>

        <Panel
          title="Upcoming campaign events"
          meta={`${formatCount(events.length)} in your territory`}
          actions={
            <Link className="btn btn-sm" href="/candidates">
              Browse candidates
            </Link>
          }
        >
          {events.length === 0 ? (
            <StateView kind="empty" title="No published events in your territory" />
          ) : (
            <div className="campaign-event-grid">
              {events.slice(0, 6).map((item) => (
                <article key={item.id} className="campaign-event-card">
                  {item.coverImageUrl ? (
                    <img src={item.coverImageUrl} alt={item.title} className="campaign-event-cover" />
                  ) : (
                    <div className="campaign-event-cover fallback">Event</div>
                  )}
                  <div className="campaign-event-copy">
                    <p className="eyebrow">{item.candidate?.name || "Campaign event"}</p>
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                    <p className="muted-text">
                      {new Date(item.startsAt).toLocaleString()} · {item.venue}
                    </p>
                    <p className="muted-text">
                      {item.territoryLabels.state || "Ogun State"}
                      {item.territoryLabels.lga ? ` · ${item.territoryLabels.lga}` : ""}
                    </p>
                    <div className="btn-row">
                      <button className="btn btn-sm" type="button" onClick={() => void handleEventRsvp(item.id, "INTERESTED")}>
                        {item.rsvp?.status === "INTERESTED" ? "Interested" : "Mark interested"}
                      </button>
                      <button
                        className="btn btn-sm btn-primary"
                        type="button"
                        onClick={() => void handleEventRsvp(item.id, "GOING")}
                      >
                        {item.rsvp?.status === "GOING" ? "Going" : "RSVP going"}
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <PanelGrid wide>
          <Panel title="Optional engagement tasks" flush>
            <DataTable
              head={
                <tr>
                  <th>Task</th>
                  <th className="numeric">Progress</th>
                  <th className="numeric">Points</th>
                  <th className="actions">Action</th>
                </tr>
              }
            >
              {engagementTasks.length === 0 ? (
                <EmptyRow colSpan={4}>No engagement tasks are active in your territory.</EmptyRow>
              ) : (
                engagementTasks.slice(0, 8).map((task) => (
                  <tr key={task.id}>
                    <td>
                      <strong>{task.title}</strong>
                      {task.description ? <div className="muted-text">{task.description}</div> : null}
                      <div className="muted-text">{task.type.replace(/_/g, " ").toLowerCase()}</div>
                    </td>
                    <td className="numeric">
                      {task.progressCount}/{task.targetCount || 1}
                    </td>
                    <td className="numeric">{formatCount(task.rewardPoints)}</td>
                    <td className="actions">
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={!task.completed || task.claimed}
                        onClick={() => void handleClaimTask(task.id)}
                      >
                        {task.claimed ? "Claimed" : task.completed ? "Claim" : "In progress"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </DataTable>
          </Panel>

          <Panel title="Campaign updates">
            {posts.length === 0 ? (
              <StateView kind="empty" title="No campaign updates in your territory" />
            ) : (
              <ul className="stack-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {posts.slice(0, 6).map((post) => (
                  <li key={post.id}>
                    <strong>{post.title}</strong>
                    <p className="muted-text">{post.content}</p>
                    <p className="muted-text">{new Date(post.createdAt).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </PanelGrid>
      </div>
    </main>
  );
}
