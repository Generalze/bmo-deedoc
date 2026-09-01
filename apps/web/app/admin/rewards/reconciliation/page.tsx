"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminNav } from "../../../../components/admin-nav";
import {
  DataTable,
  Field,
  Money,
  Notice,
  PageHead,
  Panel,
  Stat,
  StatRow,
  StateView,
  StatusPill,
  formatCount,
} from "../../../../components/ui";
import {
  approveLegacyReconciliationPolicy,
  draftLegacyReconciliationPolicy,
  fetchLegacyCarryover,
  fetchLegacyReconciliationPolicies,
  reconcileLegacyCarryover,
  type LegacyCarryoverRow,
  type LegacyMigrationBatchRow,
  type LegacyReconciliationPolicy,
} from "../../../../lib/api";
import { describeApiError, isSessionExpired, type DescribedError } from "../../../../lib/api-errors";
import { clearSession, readSession } from "../../../../lib/session";

/**
 * Legacy reconciliation.
 *
 * This surface existed only as API before now, which meant the governance step
 * that unblocks every carryover conversion could only be performed with curl —
 * while the member dashboard was already promising members their preserved
 * balance becomes spendable "once an approved conversion rate is applied".
 *
 * The screen is deliberately shaped around the fact that a legacy point has no
 * approved relationship to an authoritative one until somebody decides it does.
 * Drafting a ratio and approving it are two separate actions on purpose, so no
 * single click can both invent a valuation and apply it to member balances.
 */
export default function LegacyReconciliationPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [policies, setPolicies] = useState<LegacyReconciliationPolicy[]>([]);
  const [carryovers, setCarryovers] = useState<LegacyCarryoverRow[]>([]);
  const [batches, setBatches] = useState<LegacyMigrationBatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<DescribedError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState({ version: "", conversionRatio: "", rationale: "" });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (activeToken: string) => {
      try {
        const [policyResult, carryoverResult] = await Promise.all([
          fetchLegacyReconciliationPolicies(activeToken),
          fetchLegacyCarryover(activeToken),
        ]);
        setPolicies(policyResult.policies);
        setCarryovers(carryoverResult.carryovers);
        setBatches(carryoverResult.batches);
        setProblem(null);
      } catch (error) {
        if (isSessionExpired(error)) {
          clearSession();
          router.replace("/login");
          return;
        }
        // A 403 is reported, never treated as a dead session: signing an
        // operator out mid-shift because one screen is above their role is
        // worse than the 403 itself.
        setProblem(describeApiError(error));
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    const stored = readSession();
    if (!stored) {
      router.replace("/login");
      return;
    }
    setToken(stored);
    void load(stored);
  }, [load, router]);

  const approvedPolicy = policies.find((policy) => policy.status === "APPROVED") || null;
  const pendingCarryovers = carryovers.filter((row) => row.status === "LEGACY_CARRYOVER_PENDING");
  const pendingPoints = pendingCarryovers.reduce((total, row) => total + row.legacyPointBalance, 0);

  async function run(key: string, action: () => Promise<string>) {
    if (!token) return;
    setBusy(key);
    setMessage(null);
    setProblem(null);
    try {
      const note = await action();
      setMessage(note);
      await load(token);
    } catch (error) {
      setProblem(describeApiError(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="console">
      <AdminNav />
      <main className="console-shell">
        <PageHead
          title="Legacy reconciliation"
          lead={
            <>
              Legacy balances were preserved at cutover, not credited. They stay non-spendable until governance approves
              an equivalence ratio between a legacy point and an authoritative one.{" "}
              <Link href="/admin/rewards">Back to rewards</Link>
            </>
          }
        />

        {!approvedPolicy ? (
          <Notice tone="refused" title="No approved ratio — conversion is refused">
            <span>
              Every reconciliation returns <code>RECONCILIATION_POLICY_NOT_APPROVED</code> until a policy is approved
              below. This is the intended state, not a fault: nothing converts on a guess.
            </span>
          </Notice>
        ) : (
          <Notice tone="ok" title={`Approved ratio in force — ${approvedPolicy.version}`}>
            <span>
              1 legacy point converts to {approvedPolicy.conversionRatio} authoritative points. Approving another policy
              retires this one.
            </span>
          </Notice>
        )}

        {message ? (
          <div style={{ marginTop: "var(--sp-3)" }}>
            <Notice tone="ok" title={message} />
          </div>
        ) : null}
        {problem ? (
          <div style={{ marginTop: "var(--sp-3)" }}>
            <Notice tone={problem.refused ? "refused" : "error"} title={problem.title}>
              <span>{problem.detail}</span>
              {problem.nextStep ? <span className="muted-text">{problem.nextStep}</span> : null}
            </Notice>
          </div>
        ) : null}

        <div className="stack-4" style={{ marginTop: "var(--sp-4)" }}>
          <StatRow>
            <Stat label="Members carrying legacy value" value={formatCount(pendingCarryovers.length)} />
            <Stat
              label="Legacy points pending"
              value={formatCount(pendingPoints)}
              note="Preserved, not payable"
              warn
            />
            <Stat label="Migration batches" value={formatCount(batches.length)} />
            <Stat
              label="Approved policies"
              value={formatCount(policies.filter((policy) => policy.status === "APPROVED").length)}
              note={approvedPolicy ? approvedPolicy.version : "None — conversion refused"}
              warn={!approvedPolicy}
            />
          </StatRow>

          <Panel title="Equivalence policy" meta="Draft, then approve — two deliberate acts">
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                const ratio = Number(draft.conversionRatio);
                if (!Number.isFinite(ratio) || ratio <= 0) {
                  setProblem({
                    title: "Ratio must be a positive number",
                    detail: "Enter the authoritative points a single legacy point converts to.",
                    refused: false,
                  });
                  return;
                }
                void run("draft", async () => {
                  await draftLegacyReconciliationPolicy(token!, {
                    version: draft.version.trim(),
                    conversionRatio: ratio,
                    rationale: draft.rationale.trim() || undefined,
                  });
                  setDraft({ version: "", conversionRatio: "", rationale: "" });
                  return "Policy drafted. It converts nothing until approved.";
                });
              }}
            >
              <Field label="Version" hint="Recorded on every credit this policy produces.">
                <input
                  value={draft.version}
                  onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                  placeholder="legacy-reconciliation-v1"
                  minLength={3}
                  required
                />
              </Field>
              <Field label="Conversion ratio" hint="Authoritative points per legacy point. 1.0 is parity.">
                <input
                  value={draft.conversionRatio}
                  onChange={(event) => setDraft({ ...draft, conversionRatio: event.target.value })}
                  inputMode="decimal"
                  placeholder="0.5"
                  required
                />
              </Field>
              <Field label="Rationale" hint="Why governance set this ratio. Carried into the audit trail.">
                <input
                  value={draft.rationale}
                  onChange={(event) => setDraft({ ...draft, rationale: event.target.value })}
                  placeholder="Board resolution 2026-03"
                />
              </Field>
              <div style={{ alignSelf: "end" }}>
                <button className="btn btn-primary" type="submit" disabled={busy !== null}>
                  {busy === "draft" ? "Drafting…" : "Draft policy"}
                </button>
              </div>
            </form>
          </Panel>

          <Panel title="Policies" flush>
            {loading ? (
              <StateView kind="loading" title="Loading policies…" />
            ) : policies.length === 0 ? (
              <StateView
                kind="empty"
                title="No policy has been proposed"
                detail="Draft one above. Until a policy is approved, no legacy balance can convert."
              />
            ) : (
              <DataTable
                head={
                  <tr>
                    <th>Version</th>
                    <th className="numeric">Ratio</th>
                    <th>Status</th>
                    <th>Rationale</th>
                    <th>Approved</th>
                    <th className="actions">Action</th>
                  </tr>
                }
              >
                {policies.map((policy) => (
                  <tr key={policy.id}>
                    <td>{policy.version}</td>
                    <td className="numeric">{policy.conversionRatio}</td>
                    <td>
                      <StatusPill status={policy.status} />
                    </td>
                    <td className="muted-text">{policy.rationale || "—"}</td>
                    <td className="muted-text">
                      {policy.approvedAt ? new Date(policy.approvedAt).toLocaleString() : "—"}
                    </td>
                    <td className="actions">
                      {policy.status === "DRAFT" ? (
                        <button
                          className="btn btn-sm"
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(`approve-${policy.id}`, async () => {
                              await approveLegacyReconciliationPolicy(token!, policy.id);
                              return `Policy ${policy.version} approved. It is now the ratio reconciliation uses.`;
                            })
                          }
                        >
                          Approve
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

          <Panel title="Migration batches" meta="Checksums make the cutover auditable" flush>
            {loading ? (
              <StateView kind="loading" title="Loading batches…" />
            ) : batches.length === 0 ? (
              <StateView
                kind="empty"
                title="No cutover has been run"
                detail="Legacy balances are migrated by the cutover script; nothing has been carried over yet."
              />
            ) : (
              <DataTable
                head={
                  <tr>
                    <th>Executed</th>
                    <th className="numeric">Members</th>
                    <th className="numeric">Migrated</th>
                    <th className="numeric">Pending</th>
                    <th className="numeric">Reconciled</th>
                    <th>Snapshot checksum</th>
                  </tr>
                }
              >
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{new Date(batch.executedAt).toLocaleString()}</td>
                    <td className="numeric">{formatCount(batch.memberCount)}</td>
                    <td className="numeric">{formatCount(batch.migratedTotalPoints)}</td>
                    <td className="numeric">{formatCount(batch.pendingTotalPoints)}</td>
                    <td className="numeric">{formatCount(batch.reconciledTotalPoints)}</td>
                    <td>
                      <code className="muted-text">{batch.snapshotChecksum.slice(0, 16)}…</code>
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>

          <Panel title="Carried balances" meta={`${carryovers.length} member records`} flush>
            {loading ? (
              <StateView kind="loading" title="Loading carried balances…" />
            ) : carryovers.length === 0 ? (
              <StateView kind="empty" title="No member holds a carried legacy balance" />
            ) : (
              <DataTable
                head={
                  <tr>
                    <th>Member</th>
                    <th className="numeric">Legacy points</th>
                    <th>Status</th>
                    <th className="numeric">Credited</th>
                    <th>Applied ratio</th>
                    <th className="actions">Action</th>
                  </tr>
                }
              >
                {carryovers.map((row) => (
                  <tr key={row.id}>
                    <td>{row.memberName}</td>
                    <td className="numeric">{formatCount(row.legacyPointBalance)}</td>
                    <td>
                      <StatusPill status={row.status} />
                    </td>
                    <td className="numeric">
                      {row.creditedPoints === null ? <span className="muted-text">—</span> : formatCount(row.creditedPoints)}
                    </td>
                    <td className="muted-text">
                      {row.conversionRatio ? `${row.conversionRatio} · ${row.reconciliationRuleVersion}` : "—"}
                    </td>
                    <td className="actions">
                      {row.status === "LEGACY_CARRYOVER_PENDING" ? (
                        <button
                          className="btn btn-sm"
                          type="button"
                          disabled={busy !== null || !approvedPolicy}
                          title={approvedPolicy ? undefined : "Approve an equivalence policy first"}
                          onClick={() =>
                            void run(`reconcile-${row.id}`, async () => {
                              await reconcileLegacyCarryover(token!, { carryoverId: row.id });
                              return `Reconciled ${row.memberName}'s balance at the approved ratio.`;
                            })
                          }
                        >
                          Reconcile
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
        </div>
      </main>
    </div>
  );
}
