"use client";

import { useState } from "react";
import { Field } from "./ui";

/**
 * Collects the payment reference for a money-out execution.
 *
 * The reference must come from the operator, from the actual bank transaction.
 * The previous "Mark paid" button generated one client-side as
 * `PO-${id}-${Date.now()}`, which defeated the guarantee it was meant to carry:
 * a timestamp is unique by construction, so the server's duplicate check could
 * never fire, and the immutable execution record was stamped with an identifier
 * that matched nothing in any bank statement. There is deliberately no
 * generate-for-me affordance here.
 */
export function PaymentReferenceDialog({
  open,
  title,
  summary,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  summary: React.ReactNode;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (input: { paymentReference: string; proofStorageKey?: string; note?: string }) => void;
}) {
  const [paymentReference, setPaymentReference] = useState("");
  const [proofStorageKey, setProofStorageKey] = useState("");
  const [note, setNote] = useState("");

  if (!open) return null;

  const trimmed = paymentReference.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < 3;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(16, 31, 46, 0.45)",
        display: "grid",
        placeItems: "center",
        padding: "var(--sp-4)",
        zIndex: 60,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="panel-console"
        style={{ maxWidth: "34rem", width: "100%", boxShadow: "var(--e-3)" }}
      >
        <header className="panel-head">
          <h2>{title}</h2>
        </header>
        <form
          className="panel-body stack-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length < 3) return;
            onConfirm({
              paymentReference: trimmed,
              proofStorageKey: proofStorageKey.trim() || undefined,
              note: note.trim() || undefined,
            });
          }}
        >
          <div className="muted-text">{summary}</div>

          <Field
            label="Payment reference"
            hint="From the bank transaction that moved the money. It must identify this payment and no other."
            error={tooShort ? "Enter at least 3 characters." : undefined}
          >
            <input
              value={paymentReference}
              onChange={(event) => setPaymentReference(event.target.value)}
              placeholder="e.g. GTB/2026/0412/88231"
              autoFocus
              required
              minLength={3}
            />
          </Field>

          <Field label="Proof storage key" hint="Optional. Key of the uploaded payment evidence.">
            <input value={proofStorageKey} onChange={(event) => setProofStorageKey(event.target.value)} />
          </Field>

          <Field label="Note" hint="Optional.">
            <input value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>

          <div className="btn-row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={busy || trimmed.length < 3}>
              {busy ? "Recording…" : "Record payment"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
