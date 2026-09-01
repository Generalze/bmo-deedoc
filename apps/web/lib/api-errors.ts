import { ApiError } from "./api";

/**
 * Turns an API failure into something an operator can act on.
 *
 * The financial work deliberately refuses things: payout execution is disabled
 * by default, no reconciliation policy is approved, a payment reference may
 * already identify a payment. Those are not faults — they are the system
 * working. Before this, no screen inspected a status or an error code, so every
 * refusal surfaced as a generic failure or as nothing at all, and the most
 * common one (the kill switch) looked exactly like a dead button.
 *
 * `refused` separates "declined on purpose" from "something broke" so the UI can
 * colour and word them differently, and `nextStep` says what would unblock it.
 */

export type DescribedError = {
  title: string;
  detail: string;
  /** True when the server declined deliberately rather than failing. */
  refused: boolean;
  /** What the operator can do about it, when there is something. */
  nextStep?: string;
  code?: string;
};

const REFUSALS: Record<string, Omit<DescribedError, "refused">> = {
  RECONCILIATION_POLICY_NOT_APPROVED: {
    title: "No approved reconciliation policy",
    detail:
      "Legacy balances cannot be converted until governance approves an equivalence ratio between a legacy point and an authoritative one.",
    nextStep: "Draft a policy and approve it on the Legacy reconciliation screen.",
    code: "RECONCILIATION_POLICY_NOT_APPROVED",
  },
  DUPLICATE_PAYMENT_REFERENCE: {
    title: "Payment reference already used",
    detail: "That reference already identifies a completed payout. A reference may identify exactly one payment.",
    nextStep: "Enter the reference from the actual bank transaction for this payment.",
    code: "DUPLICATE_PAYMENT_REFERENCE",
  },
  ALREADY_EXECUTED: {
    title: "Already paid",
    detail: "This payout has already been executed. Reload to see the recorded execution.",
    code: "ALREADY_EXECUTED",
  },
  INVALID_STATE: {
    title: "Not in a payable state",
    detail: "The record is not in a state this action can move it from.",
    code: "INVALID_STATE",
  },
  AMOUNT_NOT_AUTHORITATIVE: {
    title: "Amount is not server-derived",
    detail:
      "The stored figure was not produced by the payout authority — most often a payout cycle created before server-side valuation, or a redemption funded by an unreconciled legacy balance.",
    nextStep: "Recreate the cycle so its terms come from the active payout configuration.",
    code: "AMOUNT_NOT_AUTHORITATIVE",
  },
};

export function describeApiError(error: unknown): DescribedError {
  if (!(error instanceof ApiError)) {
    return {
      title: "Request failed",
      detail: error instanceof Error ? error.message : "An unexpected error occurred.",
      refused: false,
    };
  }

  const details = (error.details || {}) as { code?: string; message?: string; payoutExecutionEnabled?: boolean };

  if (details.code && REFUSALS[details.code]) {
    return { ...REFUSALS[details.code], refused: true };
  }

  // The kill switch reports itself by field rather than by code.
  if (details.payoutExecutionEnabled === false) {
    return {
      title: "Payout execution is disabled",
      detail:
        "PAYOUT_EXECUTION_ENABLED is false, so no payment can be completed. This is the default in every environment, production included.",
      nextStep: "An operator must enable execution deliberately, after reconciliation and readiness gates pass.",
      refused: true,
      code: "PAYOUT_EXECUTION_DISABLED",
    };
  }

  if (error.status === 401) {
    return { title: "Session expired", detail: "Sign in again to continue.", refused: false };
  }
  if (error.status === 403) {
    return {
      title: "Not permitted",
      detail: error.message || "Your role cannot perform this action.",
      refused: true,
    };
  }
  if (error.status === 409) {
    return { title: "Refused", detail: error.message, refused: true };
  }

  return { title: "Request failed", detail: error.message, refused: false };
}

/** True only for a genuine authentication failure — never for a 403. */
export function isSessionExpired(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}
