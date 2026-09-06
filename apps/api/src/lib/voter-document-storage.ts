import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../prisma";
import { createAuditLog } from "./audit";
import {
  PRIVATE_STORAGE_PREFIXES,
  discardPendingObject,
  getPrivateObjectStorage,
  isPendingObjectKey,
  promotePendingObject,
} from "@pics-nigeria/object-storage";

/**
 * The single authority for taking custody of a voter-registration document.
 *
 * Feature 029 requires these documents to be stored privately, reachable only
 * through authentication, authorization and controlled short-lived access, with
 * permanent public URLs prohibited. None of that was true: the record carried a
 * storage key the client chose, a file size the client stated and a SHA-256 the
 * client computed, with `storageProvider` set to the literal string
 * "PRIVATE_OBJECT_STORAGE_STUB". No bytes were ever uploaded.
 *
 * Two consequences followed. The storage key referred to nothing, so a
 * validator deciding someone's identity had no document to look at. And the
 * duplicate-document check — which flags a submission as fraudulent when its
 * hash matches another member's — compared hashes that the submitting client
 * was free to invent, so it could be evaded by changing a digit and triggered
 * against an innocent member by copying theirs.
 *
 * Both submission paths — registration and resubmission — go through here, so
 * neither can drift back to trusting a client about where a document lives or
 * what it hashes to.
 */

export const VOTER_DOCUMENT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

export const MAX_VOTER_DOCUMENT_BYTES = 8 * 1024 * 1024;

/**
 * What a client may say about its document: what it is called and what kind of
 * file it claims to be, plus the bytes. There is deliberately no storage key,
 * no file size and no hash — each of those is a fact about the object that only
 * the server is in a position to establish.
 */
export const voterDocumentSubmissionSchema = z.object({
  originalFileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(VOTER_DOCUMENT_MIME_TYPES),
  /** Base64 document bytes. The size limit is enforced on the decoded buffer. */
  content: z.string().min(1),
});

export type VoterDocumentSubmission = z.infer<typeof voterDocumentSubmissionSchema>;

export type StoredVoterDocument = {
  documentId: string;
  /**
   * Where the bytes are right now: inside the pending namespace, owned by no
   * committed row. Promotion moves them to originalStorageKey.
   */
  pendingStorageKey: string;
  /** Where the committed row points, and where the bytes end up. */
  originalStorageKey: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  storageProvider: string;
  storageBucket: string;
  serverReceivedAt: Date;
};

export class VoterDocumentRejected extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Server-owned object keys. The document id is generated here, so one member
 * cannot name another member's object and two submissions cannot collide.
 *
 * Two keys, one document: the bytes land in the pending namespace and move to
 * the committed key only after the row that owns them exists.
 */
function voterDocumentObjectKeys(documentId: string, fileName: string, now: Date) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return {
    pendingStorageKey: `${PRIVATE_STORAGE_PREFIXES.voterVerificationPending}/${documentId}-${safeName}`,
    originalStorageKey: `${PRIVATE_STORAGE_PREFIXES.voterVerification}/${year}/${month}/${documentId}-${safeName}`,
  };
}

/**
 * A declared MIME type is a claim. The magic number is the evidence, so a PDF
 * renamed to .jpg — or a file that is neither — is refused rather than stored
 * and shown to a validator as an image that will not render.
 */
function contentTypeError(mimeType: string, body: Buffer): string | null {
  if (body.byteLength === 0) {
    return "The document is empty.";
  }
  if (body.byteLength > MAX_VOTER_DOCUMENT_BYTES) {
    return "The document exceeds the 8MB limit.";
  }

  const isJpeg = body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  const isPng =
    body.length > 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp =
    body.length > 12 &&
    body.subarray(0, 4).toString("ascii") === "RIFF" &&
    body.subarray(8, 12).toString("ascii") === "WEBP";
  const isPdf = body.length > 5 && body.subarray(0, 5).toString("ascii") === "%PDF-";

  const matches =
    (mimeType === "image/jpeg" && isJpeg) ||
    (mimeType === "image/png" && isPng) ||
    (mimeType === "image/webp" && isWebp) ||
    (mimeType === "application/pdf" && isPdf);

  return matches ? null : "The document content does not match the declared type.";
}

/**
 * Stores the bytes and returns the fields the database record must carry.
 *
 * The object is written before any row exists. A record naming an object that
 * is not there is precisely the state this replaces, so the caller only has
 * something to write once there is something to point at.
 */
export async function storeVoterDocument(input: {
  submission: VoterDocumentSubmission;
  memberUserId: string;
}): Promise<StoredVoterDocument> {
  const body = Buffer.from(input.submission.content, "base64");

  const contentError = contentTypeError(input.submission.mimeType, body);
  if (contentError) {
    throw new VoterDocumentRejected(400, "INVALID_DOCUMENT_CONTENT", contentError);
  }

  const serverReceivedAt = new Date();
  const documentId = crypto.randomUUID();
  const { pendingStorageKey, originalStorageKey } = voterDocumentObjectKeys(
    documentId,
    input.submission.originalFileName,
    serverReceivedAt,
  );
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const storage = getPrivateObjectStorage();

  let stored;
  try {
    stored = await storage.putObjectIfAbsent({
      key: pendingStorageKey,
      body,
      contentType: input.submission.mimeType,
      metadata: { documentId, sha256, memberUserId: input.memberUserId, custody: "pending" },
    });
  } catch {
    // Refuse the submission rather than record a document that is not stored.
    throw new VoterDocumentRejected(
      503,
      "DOCUMENT_STORAGE_UNAVAILABLE",
      "Private document storage is unavailable. The document was not accepted.",
    );
  }

  if (stored.sha256 !== sha256) {
    throw new VoterDocumentRejected(
      500,
      "STORED_HASH_MISMATCH",
      "Stored document hash did not match the server hash.",
    );
  }

  return {
    documentId,
    pendingStorageKey,
    originalStorageKey,
    originalFileName: input.submission.originalFileName,
    mimeType: input.submission.mimeType,
    fileSize: body.byteLength,
    sha256,
    storageProvider: storage.runtime,
    storageBucket: storage.bucket,
    serverReceivedAt,
  };
}


/**
 * The registration or submission transaction committed. Move the bytes to the
 * key that row points at.
 *
 * Called after commit, deliberately. Promoting first and rolling back would
 * leave a committed object no cleanup path may delete — which is the state this
 * whole model exists to prevent.
 *
 * A failure here is recoverable rather than silent: the row exists, the access
 * route already refuses a missing object with an audited reason, and the bytes
 * are still in the pending namespace to be promoted again.
 */
export async function commitVoterDocument(stored: StoredVoterDocument): Promise<void> {
  await promotePendingObject({
    pendingKey: stored.pendingStorageKey,
    committedKey: stored.originalStorageKey,
  });
}

/**
 * The transaction failed. Remove the bytes nothing owns.
 *
 * Returns whether the object is actually gone. A caller must not report a clean
 * rollback while identity-document bytes are still retained, so the failure is
 * surfaced rather than swallowed.
 */
export async function discardVoterDocument(stored: StoredVoterDocument): Promise<{ discarded: boolean; error?: string }> {
  try {
    await discardPendingObject(stored.pendingStorageKey);
    return { discarded: true };
  } catch (caught) {
    return { discarded: false, error: caught instanceof Error ? caught.message : String(caught) };
  }
}


/**
 * Runs a submission transaction with the document's custody attached to its
 * outcome.
 *
 * The bytes are already in the pending namespace, owned by nothing. Either the
 * row is committed and they are promoted to the key it names, or they are
 * discarded — a submission that did not take effect must not retain someone's
 * identity document.
 *
 * `committed` exists because "did not throw" is not the same as "committed".
 * Both submission transactions convert some failures into a returned value: one
 * returns null when the verification is already approved, the other returns the
 * Error itself. Treating either as success would promote an object that no row
 * points at — the same orphan, moved to a different key. The caller states what
 * commitment looks like, and the default only accepts a non-null result.
 */
export async function withVoterDocumentCustody<T>(
  options: {
    stored: StoredVoterDocument;
    actorUserId: string;
    committed?: (result: T) => boolean;
  },
  run: () => Promise<T>,
): Promise<T> {
  const committed = options.committed ?? ((result: T) => result !== null && result !== undefined);

  let result: T;
  try {
    result = await run();
  } catch (caught) {
    await cleanUpAfterFailure(options.stored, options.actorUserId);
    throw caught;
  }

  if (!committed(result)) {
    await cleanUpAfterFailure(options.stored, options.actorUserId);
    return result;
  }

  // After commit, deliberately. Promoting first and then rolling back would
  // strand a committed object that no cleanup path is permitted to delete.
  try {
    await commitVoterDocument(options.stored);
  } catch (promotionError) {
    await createAuditLog(prisma, {
      actorUserId: options.actorUserId,
      action: "VERIFICATION_DOCUMENT_PROMOTION_FAILED",
      targetType: "VoterVerificationDocument",
      targetId: options.stored.documentId,
      metadata: {
        pendingStorageKey: options.stored.pendingStorageKey,
        committedStorageKey: options.stored.originalStorageKey,
        reason: promotionError instanceof Error ? promotionError.message : String(promotionError),
        consequence: "The document record exists; access refuses until the object is promoted.",
      },
    }).catch(() => undefined);
  }

  return result;
}

async function cleanUpAfterFailure(stored: StoredVoterDocument, actorUserId: string) {
  const cleanup = await discardVoterDocument(stored);
  if (cleanup.discarded) {
    return;
  }
  // Never reported as a clean rollback: the bytes are still there.
  await createAuditLog(prisma, {
    actorUserId,
    action: "VERIFICATION_DOCUMENT_ORPHAN_CLEANUP_FAILED",
    targetType: "VoterVerificationDocument",
    targetId: stored.documentId,
    metadata: {
      pendingStorageKey: stored.pendingStorageKey,
      reason: cleanup.error || "unknown",
      consequence: "Identity-document bytes remain in the pending namespace and must be removed.",
    },
  }).catch(() => undefined);
  console.error(
    `voter_document_orphan documentId=${stored.documentId} pendingStorageKey=${stored.pendingStorageKey} reason=${cleanup.error || "unknown"}`,
  );
}

/**
 * Whether a document record describes custody the server actually took.
 *
 * The database no longer refuses an incomplete row: migration 20260906180000
 * dropped those CHECK constraints so a previous application image stays a valid
 * rollback target, and that image writes the historical shape — a stub
 * provider, no bucket, no receipt time. If a rollback happens and is later
 * rolled forward, rows in that shape will exist, created *after* the migration
 * ran.
 *
 * So this cannot ask "is the provider one of the legacy literals". A literal is
 * a label, and the set of labels is open: an image nobody anticipated could
 * write a third one. It asks what custody means instead — the server recorded
 * where the object is and when it took it, and the key is in the committed
 * namespace rather than the pending one.
 *
 * Anything short of that is unavailable, and no signed URL is issued for it.
 * Failing closed here is what keeps a relaxed database from becoming a relaxed
 * product.
 */
export function isServableCustody(document: {
  storageProvider: string;
  storageBucket: string | null;
  serverReceivedAt: Date | null;
  originalStorageKey: string;
}): boolean {
  if (!document.storageBucket) return false;
  if (!document.serverReceivedAt) return false;
  // Pending objects are owned by no committed row and may be swept at any time.
  if (isPendingObjectKey(document.originalStorageKey)) return false;
  if (!document.originalStorageKey.startsWith(`${PRIVATE_STORAGE_PREFIXES.voterVerification}/`)) return false;
  return true;
}

/** Why a record is not servable, for the audit trail. */
export function describeIncompleteCustody(document: {
  storageProvider: string;
  storageBucket: string | null;
  serverReceivedAt: Date | null;
  originalStorageKey: string;
}): string {
  if (!document.storageBucket) return "NO_STORAGE_BUCKET_RECORDED";
  if (!document.serverReceivedAt) return "NO_SERVER_RECEIPT_TIME_RECORDED";
  if (isPendingObjectKey(document.originalStorageKey)) return "OBJECT_NEVER_LEFT_PENDING_CUSTODY";
  return "STORAGE_KEY_OUTSIDE_COMMITTED_NAMESPACE";
}
