"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchPublicLgas, fetchPublicPollingUnits, fetchPublicStates, fetchPublicWards, registerVoterUser } from "../../lib/api";
import { Field, Notice, PageHead, Panel } from "../../components/ui";

type FormState = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  voterCardNumber: string;
  stateId: string;
  lgaId: string;
  wardId: string;
  pollingUnitId: string;
  referredByCode: string;
  acceptTerms: boolean;
  acceptPrivacy: boolean;
  contactConsent: boolean;
  documentProcessingConsent: boolean;
  confirmAdult: boolean;
};

const initialForm: FormState = {
  fullName: "",
  email: "",
  phone: "",
  password: "",
  voterCardNumber: "",
  stateId: "",
  lgaId: "",
  wardId: "",
  pollingUnitId: "",
  referredByCode: "",
  acceptTerms: false,
  acceptPrivacy: false,
  contactConsent: false,
  documentProcessingConsent: false,
  confirmAdult: false,
};

/**
 * The document itself, not a description of it.
 *
 * This previously hashed the file locally and sent the hash with an invented
 * storage key, while the bytes went nowhere. The server now receives the
 * document and derives the key, the size and the hash from it.
 */
async function fileToBase64(file: File) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < buffer.length; index += chunkSize) {
    binary += String.fromCharCode(...buffer.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialForm);
  const [states, setStates] = useState<Array<{ id: string; name: string }>>([]);
  const [lgas, setLgas] = useState<Array<{ id: string; name: string }>>([]);
  const [wards, setWards] = useState<Array<{ id: string; name: string }>>([]);
  const [pollingUnits, setPollingUnits] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [voterDocument, setVoterDocument] = useState<File | null>(null);

  useEffect(() => {
    const referralCode = new URLSearchParams(window.location.search).get("ref");
    if (referralCode) {
      setForm((current) => ({ ...current, referredByCode: referralCode.toUpperCase() }));
    }

    async function loadStates() {
      try {
        const availableStates = await fetchPublicStates();
        setStates(availableStates);
        // Ogun-only: selecting the single state for the registrant removes a
        // dead step and unblocks the dependent LGA lookup straight away.
        if (availableStates.length === 1) {
          setForm((current) => (current.stateId ? current : { ...current, stateId: availableStates[0].id }));
        }
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Could not load registration options.");
      }
    }

    void loadStates();
  }, []);

  useEffect(() => {
    if (!form.stateId) {
      setLgas([]);
      setWards([]);
      setPollingUnits([]);
      setForm((current) => ({ ...current, lgaId: "", wardId: "", pollingUnitId: "" }));
      return;
    }

    async function loadLgas() {
      try {
        const nextLgas = await fetchPublicLgas(form.stateId);
        setLgas(nextLgas);
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Could not load local governments.");
      }
    }

    setForm((current) => ({ ...current, lgaId: "", wardId: "", pollingUnitId: "" }));
    setWards([]);
    setPollingUnits([]);
    void loadLgas();
  }, [form.stateId]);

  useEffect(() => {
    if (!form.stateId || !form.lgaId) {
      setWards([]);
      setPollingUnits([]);
      setForm((current) => ({ ...current, wardId: "", pollingUnitId: "" }));
      return;
    }

    async function loadWards() {
      try {
        const nextWards = await fetchPublicWards(form.stateId, form.lgaId);
        setWards(nextWards);
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Could not load wards.");
      }
    }

    setForm((current) => ({ ...current, wardId: "", pollingUnitId: "" }));
    setPollingUnits([]);
    void loadWards();
  }, [form.stateId, form.lgaId]);

  useEffect(() => {
    if (!form.stateId || !form.lgaId || !form.wardId) {
      setPollingUnits([]);
      setForm((current) => ({ ...current, pollingUnitId: "" }));
      return;
    }

    async function loadPollingUnits() {
      try {
        const nextPollingUnits = await fetchPublicPollingUnits(form.stateId, form.lgaId, form.wardId);
        setPollingUnits(nextPollingUnits);
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Could not load polling units.");
      }
    }

    setForm((current) => ({ ...current, pollingUnitId: "" }));
    void loadPollingUnits();
  }, [form.stateId, form.lgaId, form.wardId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      if (!form.acceptTerms || !form.contactConsent || !form.confirmAdult) {
        throw new Error("You must accept the terms and confirm eligibility before registering.");
      }
      if (voterDocument && !form.documentProcessingConsent) {
        throw new Error("Document processing consent is required before submitting voter evidence.");
      }
      if (voterDocument && !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(voterDocument.type)) {
        throw new Error("Upload a JPG, PNG, WebP, or PDF voter evidence file.");
      }

      const documentMetadata = voterDocument
        ? {
            originalFileName: voterDocument.name,
            mimeType: voterDocument.type as "image/jpeg" | "image/png" | "image/webp" | "application/pdf",
            content: await fileToBase64(voterDocument),
          }
        : undefined;

      const result = await registerVoterUser({
        ...form,
        referredByCode: form.referredByCode.trim() || undefined,
        acceptTerms: true,
        acceptPrivacy: true,
        contactConsent: true,
        documentProcessingConsent: documentMetadata ? true : undefined,
        confirmAdult: true,
        consentVersion: "pre-election-v1",
        voterDocument: documentMetadata,
      });

      setMessage(result.message);
      setForm(initialForm);
      setVoterDocument(null);
      router.push("/login");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="console-shell form-page">
      <PageHead
        title="Voter registration"
        lead="Create a voter account to participate, track rewards and follow campaign updates in your ward."
        actions={
          <Link className="btn" href="/login">
            Sign in
          </Link>
        }
      />

      <div className="stack-4">
        <Notice tone="legacy" title="Ogun State only">
          <span>
            This platform operates in Ogun State. Registration is limited to Ogun State residents. Not sure of your
            Polling Unit? <Link href="/polling-units">Find it first</Link>.
          </span>
        </Notice>

        <Panel title="Create your account">
          <form className="stack-3" onSubmit={handleSubmit}>
            <div className="form-grid">
              <Field label="Full name">
                <input value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required />
              </Field>

              <Field label="Email">
                <input
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                  required
                />
              </Field>

              <Field label="Phone" hint="Digits only, between 7 and 15.">
                <input
                  type="tel"
                  inputMode="numeric"
                  pattern="\d{7,15}"
                  minLength={7}
                  maxLength={15}
                  value={form.phone}
                  onChange={(event) => setForm({ ...form, phone: event.target.value.replace(/\D/g, "") })}
                  required
                />
              </Field>

              <Field label="Password" hint="At least 8 characters.">
                <input
                  type="password"
                  minLength={8}
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  required
                />
              </Field>
            </div>

            <Field label="Voter card number" hint="Exactly as printed on your PVC.">
              <input
                value={form.voterCardNumber}
                minLength={5}
                onChange={(event) => setForm({ ...form, voterCardNumber: event.target.value.toUpperCase() })}
                required
              />
            </Field>

            <div className="form-grid">
              <Field label="State" hint="Ogun State only.">
                <select
                  value={form.stateId}
                  onChange={(event) => setForm({ ...form, stateId: event.target.value })}
                  required
                  disabled={states.length <= 1}
                >
                  {states.length === 1 ? null : <option value="">Select state</option>}
                  {states.map((state) => (
                    <option key={state.id} value={state.id}>
                      {state.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Local Government Area">
                <select
                  value={form.lgaId}
                  onChange={(event) => setForm({ ...form, lgaId: event.target.value })}
                  required
                  disabled={!form.stateId}
                >
                  <option value="">Select LGA</option>
                  {lgas.map((lga) => (
                    <option key={lga.id} value={lga.id}>
                      {lga.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Ward">
                <select
                  value={form.wardId}
                  onChange={(event) => setForm({ ...form, wardId: event.target.value })}
                  required
                  disabled={!form.lgaId}
                >
                  <option value="">Select ward</option>
                  {wards.map((ward) => (
                    <option key={ward.id} value={ward.id}>
                      {ward.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Polling Unit">
                <select
                  value={form.pollingUnitId}
                  onChange={(event) => setForm({ ...form, pollingUnitId: event.target.value })}
                  required
                  disabled={!form.wardId}
                >
                  <option value="">Select Polling Unit</option>
                  {pollingUnits.map((pollingUnit) => (
                    <option key={pollingUnit.id} value={pollingUnit.id}>
                      {pollingUnit.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Referral code" hint="Optional.">
              <input
                value={form.referredByCode}
                onChange={(event) => setForm({ ...form, referredByCode: event.target.value })}
                placeholder="Enter a voter referral code"
              />
            </Field>

            <Field
              label="Voter evidence"
              hint="Optional. This creates a private evidence submission for validation. It is not a ballot, a vote choice, or proof of voting."
            >
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(event) => setVoterDocument(event.target.files?.[0] || null)}
              />
            </Field>

            {/*
              One label per checkbox. These were a <label> wrapping a second
              <label>, which is invalid HTML — clicking the sentence could focus
              either control or none of them.
            */}
            <div className="stack-3">
              <label className="consent">
                <input
                  type="checkbox"
                  checked={form.acceptTerms}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      acceptTerms: event.target.checked,
                      acceptPrivacy: event.target.checked,
                      contactConsent: event.target.checked,
                    })
                  }
                  required
                />
                <span>
                  I agree to the <Link href="/terms">terms and conditions</Link>, including consent for election and
                  civic updates within my registered territory, and contact handling by authorised platform operators.
                </span>
              </label>

              <label className="consent">
                <input
                  type="checkbox"
                  checked={form.documentProcessingConsent}
                  onChange={(event) => setForm({ ...form, documentProcessingConsent: event.target.checked })}
                  disabled={!voterDocument}
                  required={Boolean(voterDocument)}
                />
                <span>
                  I consent to private processing of my voter-registration evidence by authorised validators only.
                  {!voterDocument ? <span className="muted-text"> Only needed if you attach evidence above.</span> : null}
                </span>
              </label>

              <label className="consent">
                <input
                  type="checkbox"
                  checked={form.confirmAdult}
                  onChange={(event) => setForm({ ...form, confirmAdult: event.target.checked })}
                  required
                />
                <span>I confirm that I am 18 years old or above and legally eligible to register as a voter.</span>
              </label>
            </div>

            {error ? <Notice tone="error" title="Registration failed">{error}</Notice> : null}
            {message ? <Notice tone="ok" title={message} /> : null}

            <div className="btn-row">
              <button
                className="btn btn-primary"
                type="submit"
                disabled={loading || !form.acceptTerms || !form.confirmAdult}
              >
                {loading ? "Creating account…" : "Create account"}
              </button>
            </div>
          </form>
        </Panel>
      </div>
    </main>
  );
}
