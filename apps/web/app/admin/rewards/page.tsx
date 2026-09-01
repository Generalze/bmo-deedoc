"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { AuthUserProfile, RewardHistoryItem, RewardLedgerItem, RewardRedemptionItem } from "@pics-nigeria/shared";
import {
  ApiError,
  approveAdminRedemption,
  fetchAdminRedemptions,
  fetchAdminRewardLedger,
  fetchCurrentUser,
  payAdminRedemption,
  rejectAdminRedemption,
} from "../../../lib/api";
import { AdminNav } from "../../../components/admin-nav";
import { PaymentReferenceDialog } from "../../../components/payment-reference-dialog";
import {
  DataTable,
  Money,
  Notice,
  Panel,
  StateView,
  StatusPill,
  formatCount,
  formatMoney,
} from "../../../components/ui";
import { describeApiError, type DescribedError } from "../../../lib/api-errors";
import { describeTerritory } from "../../../components/admin-management-utils";
import { readSession } from "../../../lib/session";

function countByStatus(redemptions: RewardRedemptionItem[], status: RewardRedemptionItem["status"]) {
  return redemptions.filter((item) => item.status === status).length;
}

export default function AdminRewardsPage() {
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [rewardLedger, setRewardLedger] = useState<RewardLedgerItem[]>([]);
  const [rewardHistory, setRewardHistory] = useState<RewardHistoryItem[]>([]);
  const [redemptions, setRedemptions] = useState<RewardRedemptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [paying, setPaying] = useState<RewardRedemptionItem | null>(null);
  const [problem, setProblem] = useState<DescribedError | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /**
   * Every review action goes through here so a refusal is always surfaced.
   * Previously none of these paths existed at all, and the payout buttons that
   * did exist had no .catch — with payout execution disabled by default, the
   * primary money button simply did nothing and said nothing.
   */
  async function act(key: string, run: (token: string) => Promise<string>) {
    const token = readSession();
    if (!token) return;
    setBusy(key);
    setProblem(null);
    setMessage(null);
    try {
      const note = await run(token);
      setMessage(note);
      const refreshed = await fetchAdminRedemptions(token);
      setRedemptions(refreshed);
    } catch (caught) {
      setProblem(describeApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function loadPage(token: string) {
    const [currentUser, ledgerData, visibleRedemptions] = await Promise.all([
      fetchCurrentUser(token),
      fetchAdminRewardLedger(token),
      fetchAdminRedemptions(token),
    ]);

    if (currentUser.role !== "ADMIN" && currentUser.role !== "SUPER_ADMIN") {
      throw new ApiError("This page is available to admins only.", 403);
    }

    setUser(currentUser);
    setRewardLedger(ledgerData.rewardLedger);
    setRewardHistory(ledgerData.rewardHistory);
    setRedemptions(visibleRedemptions);
  }

  useEffect(() => {
    const token = readSession();
    if (!token) {
      window.location.href = "/login";
      return;
    }

    loadPage(token)
      .catch((caughtError) => setError(caughtError instanceof Error ? caughtError.message : "Could not load reward accountability."))
      .finally(() => setLoading(false));
  }, []);

  const summary = useMemo(() => ({
    pending: countByStatus(redemptions, "PENDING"),
    approved: countByStatus(redemptions, "APPROVED"),
    paid: countByStatus(redemptions, "PAID"),
    rejected: countByStatus(redemptions, "REJECTED"),
    postedPoints: rewardLedger.reduce((sum, item) => sum + item.points, 0),
  }), [redemptions, rewardLedger]);

  const ledgerTypeBreakdown = useMemo(() => {
    return rewardLedger.reduce<Record<string, number>>((accumulator, entry) => {
      accumulator[entry.type] = (accumulator[entry.type] || 0) + 1;
      return accumulator;
    }, {});
  }, [rewardLedger]);

  if (loading && !user) {
    return (
      <main className="shell">
        <section className="panel hero">
          <h1>Loading rewards...</h1>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="panel card">
          <h1>Unable to load rewards</h1>
          <p className="error">{error || "Authentication is required."}</p>
          <Link href="/admin/dashboard">Return to admin overview</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel hero">
        <p className="eyebrow">Reward accountability</p>
        <h1>Rewards and redemptions</h1>
        <p>Visible scope: {describeTerritory(user.adminProfile || {
          geoPoliticalZoneId: null,
          stateId: null,
          senatorialDistrictId: null,
          federalConstituencyId: null,
          lgaId: null,
          wardId: null,
          stateConstituencyId: null,
          pollingUnitId: null,
        })}</p>
      </section>

      <AdminNav role={user?.role} />
      {error ? <p className="error">{error}</p> : null}

      <section className="grid stats">
        <article className="panel card">
          <h2>Pending review</h2>
          <div className="value">{summary.pending}</div>
        </article>
        <article className="panel card">
          <h2>Approved</h2>
          <div className="value">{summary.approved}</div>
        </article>
        <article className="panel card">
          <h2>Paid</h2>
          <div className="value">{summary.paid}</div>
        </article>
        <article className="panel card">
          <h2>Rejected</h2>
          <div className="value">{summary.rejected}</div>
        </article>
        <article className="panel card">
          <h2>Legacy posted points</h2>
          <div className="value">{summary.postedPoints}</div>
          <p className="muted">
            Historical total from the read-only legacy ledger. New earnings post to the authoritative ledger and are
            not counted here.
          </p>
        </article>
      </section>

      <section className="panel card" style={{ marginTop: 24 }}>
        <div className="section-head">
          <div>
            <h2>Visible reward history</h2>
            <p className="muted">
              Legacy ledger entries and redemption review status inside your allowed scope. The legacy ledger is
              read-only; it records history and is not the balance any payment is made from.
            </p>
          </div>
          <span className="status-pill">{rewardHistory.length} entries</span>
        </div>
        {rewardLedger.length > 0 ? (
          <div className="badge-row" style={{ marginBottom: 16 }}>
            {Object.entries(ledgerTypeBreakdown).map(([label, count]) => (
              <span key={label} className="status-badge live">
                {label}: {count}
              </span>
            ))}
          </div>
        ) : null}

        {rewardHistory.length === 0 ? (
          <p className="muted">No reward history is visible in your current scope.</p>
        ) : (
          <div className="reward-list">
            {rewardHistory.slice(0, 20).map((entry) => (
              <article key={`${entry.kind}-${entry.id}`} className="reward-item">
                <strong>{entry.title}</strong>
                <p>{entry.description}</p>
                <p className="muted">
                  {entry.kind === "EARNED" ? "Earned entry" : "Redemption"} | {entry.status} | {entry.points} points
                </p>
                {entry.amount !== null ? <p className="muted">Amount: {entry.amount}</p> : null}
                <p className="muted">
                  Created {new Date(entry.createdAt).toLocaleString()}
                  {entry.reviewedAt ? ` | Reviewed ${new Date(entry.reviewedAt).toLocaleString()}` : ""}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      {message ? <Notice tone="ok" title={message} /> : null}
      {problem ? (
        <Notice tone={problem.refused ? "refused" : "error"} title={problem.title}>
          <span>{problem.detail}</span>
          {problem.nextStep ? <span className="muted-text">{problem.nextStep}</span> : null}
        </Notice>
      ) : null}

      <Panel
        title="Redemption review queue"
        meta={`${redemptions.length} requests`}
        flush
      >
        {redemptions.length === 0 ? (
          <StateView kind="empty" title="No redemption requests are visible in your scope" />
        ) : (
          <DataTable
            head={
              <tr>
                <th>Submitted</th>
                <th className="numeric">Points</th>
                <th className="numeric">Payable amount</th>
                <th>Status</th>
                <th>Note</th>
                <th className="actions">Review</th>
              </tr>
            }
          >
            {redemptions.slice(0, 50).map((item) => (
              <tr key={item.id}>
                <td className="muted-text">{new Date(item.createdAt).toLocaleString()}</td>
                <td className="numeric">{formatCount(item.pointsRequested)}</td>
                <td className="numeric">
                  {/* Server-computed at approval; the client never asserts it. */}
                  <Money amount={item.amountRequested} provenance="revalued" />
                </td>
                <td>
                  <StatusPill status={item.status} />
                </td>
                <td className="muted-text">{item.note || "—"}</td>
                <td className="actions">
                  {item.status === "PENDING" ? (
                    <span className="btn-row" style={{ justifyContent: "flex-end" }}>
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(`approve-${item.id}`, async (token) => {
                            await approveAdminRedemption(token, item.id, {});
                            return "Redemption approved and re-valued by the payout authority.";
                          })
                        }
                      >
                        Approve
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(`reject-${item.id}`, async (token) => {
                            await rejectAdminRedemption(token, item.id, {});
                            return "Redemption rejected.";
                          })
                        }
                      >
                        Reject
                      </button>
                    </span>
                  ) : item.status === "APPROVED" ? (
                    <button
                      className="btn btn-sm btn-primary"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setPaying(item)}
                    >
                      Mark paid…
                    </button>
                  ) : (
                    <span className="muted-text">—</span>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>

      <PaymentReferenceDialog
        open={paying !== null}
        busy={busy !== null}
        title="Record redemption payment"
        summary={
          paying ? (
            <>
              {formatCount(paying.pointsRequested)} points · {formatMoney(paying.amountRequested)}. The payment is
              re-valued by the server at execution and written to an immutable execution record.
            </>
          ) : null
        }
        onCancel={() => setPaying(null)}
        onConfirm={(input) => {
          const target = paying;
          if (!target) return;
          void act(`pay-${target.id}`, async (token) => {
            await payAdminRedemption(token, target.id, input);
            setPaying(null);
            return "Payment recorded.";
          });
        }}
      />
    </main>
  );
}
