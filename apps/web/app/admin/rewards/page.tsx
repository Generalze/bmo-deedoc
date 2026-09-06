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
  EmptyRow,
  Kpi,
  KpiRow,
  Money,
  Notice,
  PageHead,
  Panel,
  StateView,
  StatusPill,
  Toolbar,
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
      <main className="console-shell">
        <PageHead title="Rewards and redemptions" />
        <StateView kind="loading" title="Loading rewards…" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="console-shell">
        <PageHead title="Rewards and redemptions" />
        <StateView
          kind="error"
          title="Unable to load rewards"
          detail={error || "Authentication is required."}
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
        title="Rewards and redemptions"
        lead={`Visible scope: ${describeTerritory(
          user.adminProfile || {
            geoPoliticalZoneId: null,
            stateId: null,
            senatorialDistrictId: null,
            federalConstituencyId: null,
            lgaId: null,
            wardId: null,
            stateConstituencyId: null,
            pollingUnitId: null,
          },
        )}`}
      />

      <AdminNav role={user?.role} />

      <div className="stack-4">
        {error ? <Notice tone="error" title="Something went wrong">{error}</Notice> : null}

        <KpiRow>
          <Kpi
            label="Pending review"
            value={formatCount(summary.pending)}
            note="Redemptions awaiting a decision"
            tone={summary.pending > 0 ? "accent" : undefined}
          />
          <Kpi label="Approved" value={formatCount(summary.approved)} note="Valued, not yet paid" />
          <Kpi label="Paid" value={formatCount(summary.paid)} note="Executed with a payment reference" />
          <Kpi label="Rejected" value={formatCount(summary.rejected)} note="Declined on review" />
          <Kpi
            label="Legacy posted points"
            value={formatCount(summary.postedPoints)}
            note="Read-only history. New earnings post to the authoritative ledger and are not counted here."
            tone="warn"
          />
        </KpiRow>

        <Panel
          title="Visible reward history"
          meta={`${formatCount(rewardHistory.length)} entries`}
          flush
        >
          <div className="panel-body">
            <p className="muted-text">
              Legacy ledger entries and redemption review status inside your allowed scope. The legacy ledger is
              read-only; it records history and is not the balance any payment is made from.
            </p>
          </div>

          {rewardLedger.length > 0 ? (
            <Toolbar>
              <span className="cluster">
                {Object.entries(ledgerTypeBreakdown).map(([label, count]) => (
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
              <EmptyRow colSpan={6}>No reward history is visible in your current scope.</EmptyRow>
            ) : (
              rewardHistory.slice(0, 20).map((entry) => (
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
      </div>
    </main>
  );
}
