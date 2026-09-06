import crypto from "node:crypto";
import { z } from "zod";
import { PRIVATE_STORAGE_PREFIXES, getPrivateObjectStorage } from "@pics-nigeria/object-storage";

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
 * Server-owned object key. The document id is generated here, so one member
 * cannot name another member's object and two submissions cannot collide.
 */
function voterDocumentObjectKey(documentId: string, fileName: string, now: Date) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${PRIVATE_STORAGE_PREFIXES.voterVerification}/${year}/${month}/${documentId}-${safeName}`;
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
  const originalStorageKey = voterDocumentObjectKey(documentId, input.submission.originalFileName, serverReceivedAt);
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const storage = getPrivateObjectStorage();

  let stored;
  try {
    stored = await storage.putObjectIfAbsent({
      key: originalStorageKey,
      body,
      contentType: input.submission.mimeType,
      metadata: { documentId, sha256, memberUserId: input.memberUserId },
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
